import { google } from "googleapis";
import { Readable } from "node:stream";

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

async function generateFreeImage(prompt, aspectRatio, model = "flux") {
  const { width, height } = getDimensions(aspectRatio);
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 1000000);

  const modelMap = {
    "flux": "flux",
    "flux-realism": "flux-realism",
    "flux-anime": "flux-anime",
    "turbo": "turbo"
  };
  const targetModel = modelMap[model] || "flux";

  const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&model=${targetModel}&seed=${seed}&nologo=true`;

  const response = await fetch(imageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
  });

  if (!response.ok) {
    throw new Error(`Inference error: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return buffer.toString("base64");
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

      const enhancedPrompt = enhancePrompt(prompt, style);
      const imageBytes = await generateFreeImage(enhancedPrompt, aspectRatio, model);

      let driveResult = null;
      const cookies = parseCookies(req);
      const userTokens = {
        access_token: cookies.gdrive_access_token,
        refresh_token: cookies.gdrive_refresh_token
      };

      if (uploadToDrive && (userTokens.access_token || userTokens.refresh_token)) {
        try {
          const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || "1RpfZGzJ0aDTQOEQKOpwT5wpPb1RYDMIY";
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
          );
          oauth2Client.setCredentials(userTokens);
          const drive = google.drive({ version: "v3", auth: oauth2Client });

          const fileMetadata = { name: `ai_${Date.now()}.jpg`, parents: [folderId] };
          const mediaStream = new Readable();
          mediaStream.push(Buffer.from(imageBytes, "base64"));
          mediaStream.push(null);

          const file = await drive.files.create({
            resource: fileMetadata,
            media: { mimeType: "image/jpeg", body: mediaStream },
            fields: "id, name"
          });

          try {
            await drive.permissions.create({
              fileId: file.data.id,
              requestBody: { role: "reader", type: "anyone" }
            });
          } catch (_) {}

          driveResult = { success: true, driveFileId: file.data.id, folderId };
        } catch (driveErr) {
          driveResult = { success: false, error: driveErr.message };
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        dataUrl: `data:image/jpeg;base64,${imageBytes}`,
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
