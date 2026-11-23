import { GoogleGenAI } from "@google/genai";
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
      prefix: "Award-winning editorial photograph for a high-end fashion magazine, shot by Annie Leibovitz. ",
      suffix: ". Ultra-detailed skin texture, Hasselblad medium format, natural volumetric lighting, shallow depth of field, professional color grading, intimate composition, fine art photography aesthetic, 8K resolution.",
    },
    cinematic: {
      prefix: "Cinematic still from a high-budget drama film, directed by Denis Villeneuve, cinematography by Roger Deakins. ",
      suffix: ". Anamorphic lens flare, dramatic chiaroscuro lighting, filmic color palette, atmospheric haze, intimate framing, 35mm film grain, IMAX quality, emotionally evocative composition.",
    },
    fineart: {
      prefix: "Museum-quality fine art photograph exhibited at the Venice Biennale, inspired by the works of Helmut Newton and Peter Lindbergh. ",
      suffix: ". Masterful use of light and shadow, classical composition, oil-painting-like skin tones, gallery-print quality, intimate and bold aesthetic, printed on archival paper, 8K ultra-resolution.",
    },
    renaissance: {
      prefix: "Classical Renaissance oil painting in the style of Caravaggio and Botticelli, displayed at the Uffizi Gallery. ",
      suffix: ". Dramatic tenebrism lighting, rich jewel-tone palette, anatomically masterful, oil on canvas texture, gilded frame museum piece, intimate classical beauty, ultra-detailed brushwork.",
    },
    noir: {
      prefix: "Film noir styled dramatic portrait, inspired by classic Hollywood glamour photography of George Hurrell. ",
      suffix: ". High-contrast black and white with selective warm tones, dramatic single-source key light, smoky atmosphere, intimate and mysterious mood, sharp studio-quality detail, 8K.",
    },
    raw: {
      prefix: "",
      suffix: "",
    },
  };

  const preset = stylePresets[style] || stylePresets.editorial;
  return `${preset.prefix}${rawPrompt}${preset.suffix}`;
}

async function generateImageWithGemini(ai, prompt, aspectRatio) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: prompt,
      config: { responseModalities: ["IMAGE", "TEXT"] },
    });
    const candidate = response.candidates?.[0];
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.inlineData?.data) {
          return part.inlineData.data;
        }
      }
    }
  } catch (_) {}

  try {
    const result = await ai.models.generateImages({
      model: "imagen-3.0-generate-002",
      prompt: prompt,
      config: {
        numberOfImages: 1,
        outputMimeType: "image/jpeg",
        aspectRatio: aspectRatio,
        personGeneration: "ALLOW_ADULT",
      },
    });
    const bytes = result.generatedImages?.[0]?.image?.imageBytes;
    if (bytes) return bytes;
  } catch (err) {
    throw new Error(err.message || "Failed to generate image with Gemini API");
  }

  throw new Error("No image data returned from Gemini API");
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
      const { prompt, aspectRatio = "1:1", uploadToDrive = true, apiKey, style = "editorial" } = data;

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Prompt is required" }));
        return;
      }

      const effectiveKey = apiKey || process.env.GEMINI_API_KEY;
      if (!effectiveKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "GEMINI_API_KEY is not set." }));
        return;
      }

      const ai = new GoogleGenAI({ apiKey: effectiveKey });
      const enhancedPrompt = enhancePrompt(prompt, style);
      const imageBytes = await generateImageWithGemini(ai, enhancedPrompt, aspectRatio);

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

          const fileMetadata = { name: `img_${Date.now()}.jpg`, parents: [folderId] };
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
