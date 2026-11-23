import { google } from "googleapis";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(";").forEach((cookie) => {
      const parts = cookie.split("=");
      list[parts.shift().trim()] = decodeURI(parts.join("="));
    });
  }
  return list;
}

function enhancePrompt(rawPrompt, style = "editorial") {
  const stylePresets = {
    editorial: {
      prefix: "Award-winning editorial photograph for high-end magazine, Annie Leibovitz style. ",
      suffix: ", Hasselblad medium format, 85mm lens, natural volumetric lighting, shallow depth of field, 8K ultra-detailed skin and textures",
    },
    cinematic: {
      prefix: "Cinematic film still, 35mm motion picture, Denis Villeneuve aesthetic. ",
      suffix: ", anamorphic lens flare, dramatic chiaroscuro lighting, atmospheric haze, 8K photorealism",
    },
    fineart: {
      prefix: "Museum gallery fine art masterpiece photograph. ",
      suffix: ", masterpiece composition, soft gallery lighting, subtle tones, award winning",
    },
    noir: {
      prefix: "Classic Hollywood film noir portrait. ",
      suffix: ", dramatic high contrast black and white lighting, single key light, smoky atmosphere",
    },
    raw: {
      prefix: "",
      suffix: "",
    },
  };

  const preset = stylePresets[style] || stylePresets.editorial;
  return `${preset.prefix}${rawPrompt}${preset.suffix}`;
}

function getDimensions(aspectRatio) {
  switch (aspectRatio) {
    case "16:9":
      return { width: 1280, height: 720 };
    case "9:16":
      return { width: 720, height: 1280 };
    case "4:3":
      return { width: 1024, height: 768 };
    case "3:4":
      return { width: 768, height: 1024 };
    default:
      return { width: 1024, height: 1024 };
  }
}

async function synthesizeWithGemini(rawPrompt, apiKey) {
  if (!apiKey) return rawPrompt;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Act as a world-class prompt engineer for FLUX.1. Expand this concept into a breathtaking, highly-detailed photographic prompt describing scene composition, lighting, camera lens, textures, and color grading. Output ONLY the raw descriptive prompt, maximum 45 words: "${rawPrompt}"`
          }]
        }]
      })
    });
    if (res.ok) {
      const data = await res.json();
      const synthText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (synthText) return synthText.trim().replace(/^"|"$/g, "");
    }
  } catch (e) {
    console.warn("Gemini prompt synthesis error:", e.message);
  }
  return rawPrompt;
}

async function generateFreeImage(prompt, rawPrompt, aspectRatio, model = "flux") {
  const { width, height } = getDimensions(aspectRatio);
  const seed = Math.floor(Math.random() * 1000000);

  const modelMap = {
    "flux": "flux",
    "flux-realism": "flux-realism",
    "flux-anime": "flux-anime",
    "midjourney": "midjourney",
    "flux-3d": "flux-3d",
    "gemini-synth": "flux",
    "imagen-3": "flux",
    "turbo": "turbo"
  };
  const targetModel = modelMap[model] || "flux";

  // Attempt 1: Try enhanced prompt
  let imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&model=${targetModel}&seed=${seed}&nologo=true`;

  let response = await fetch(imageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
  });

  // Attempt 2: If enhanced prompt failed (e.g. 402/400), try clean raw prompt
  if (!response.ok && rawPrompt && prompt !== rawPrompt) {
    imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(rawPrompt)}?width=${width}&height=${height}&model=${targetModel}&seed=${seed}&nologo=true`;
    response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });
  }

  // Attempt 3: If still rejected, fallback to turbo model with raw prompt
  if (!response.ok) {
    imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(rawPrompt || prompt)}?width=${width}&height=${height}&model=turbo&seed=${seed}&nologo=true`;
    response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });
  }

  if (!response.ok) {
    throw new Error(`Inference error: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return buffer.toString("base64");
}

async function getOrCreateGalleryFolder(drive) {
  try {
    const listRes = await drive.files.list({
      q: "name = 'Imagen-AI-Gallery' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: "files(id, name)",
      spaces: "drive"
    });
    if (listRes.data.files && listRes.data.files.length > 0) {
      return listRes.data.files[0].id;
    }
    const createRes = await drive.files.create({
      resource: {
        name: "Imagen-AI-Gallery",
        mimeType: "application/vnd.google-apps.folder"
      },
      fields: "id, name"
    });
    return createRes.data.id;
  } catch (err) {
    console.error("Error finding or creating folder:", err.message);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", async () => {
    try {
      const data = JSON.parse(body || "{}");
      const { prompt, aspectRatio = "1:1", uploadToDrive = true, style = "editorial", model = "flux" } = data;

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Prompt is required" }));
        return;
      }

      let effectivePrompt = prompt;
      if (model === "gemini-synth") {
        effectivePrompt = await synthesizeWithGemini(prompt, process.env.GEMINI_API_KEY);
      }
      const enhancedPrompt = (model === "gemini-synth" || style === "raw") ? effectivePrompt : enhancePrompt(effectivePrompt, style);
      const imageBytes = await generateFreeImage(enhancedPrompt, prompt, aspectRatio, model);

      let driveResult = null;
      const cookies = parseCookies(req);
      const effectiveRefreshToken = cookies.gdrive_refresh_token || process.env.GOOGLE_REFRESH_TOKEN;
      const effectiveAccessToken = cookies.gdrive_access_token;

      if (uploadToDrive && (effectiveRefreshToken || effectiveAccessToken)) {
        try {
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
          );
          oauth2Client.setCredentials({
            access_token: effectiveAccessToken,
            refresh_token: effectiveRefreshToken
          });

          const drive = google.drive({ version: "v3", auth: oauth2Client });
          const folderId = await getOrCreateGalleryFolder(drive);

          const fileMetadata = {
            name: `ai_${Date.now()}.jpg`,
            ...(folderId ? { parents: [folderId] } : {})
          };

          const mediaStream = new Readable();
          mediaStream.push(Buffer.from(imageBytes, "base64"));
          mediaStream.push(null);

          const file = await drive.files.create({
            resource: fileMetadata,
            media: { mimeType: "image/jpeg", body: mediaStream },
            fields: "id, name, webViewLink, thumbnailLink"
          });

          try {
            await drive.permissions.create({
              fileId: file.data.id,
              requestBody: { role: "reader", type: "anyone" }
            });
          } catch (_) {}

          driveResult = {
            success: true,
            driveFileId: file.data.id,
            folderId,
            webViewLink: file.data.webViewLink
          };
        } catch (driveErr) {
          console.error("Drive upload error in handler:", driveErr);
          driveResult = { success: false, error: driveErr.message };
        }
      } else {
        driveResult = { success: false, reason: "Drive not connected. Please click Connect Drive." };
      }

      let localPath = null;
      try {
        const genDir = path.join(process.cwd(), "public", "generated");
        if (!fs.existsSync(genDir)) {
          fs.mkdirSync(genDir, { recursive: true });
        }
        const fileName = `ai_${Date.now()}.jpg`;
        fs.writeFileSync(path.join(genDir, fileName), Buffer.from(imageBytes, "base64"));
        localPath = `/generated/${fileName}`;
      } catch (_) {}

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      });
      res.end(JSON.stringify({
        success: true,
        dataUrl: `data:image/jpeg;base64,${imageBytes}`,
        localPath,
        driveResult,
        prompt,
        enhancedPrompt,
        style,
        aspectRatio
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message || "Failed to generate image" }));
    }
  });
}
