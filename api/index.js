import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, "public");
let driveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || "1RpfZGzJ0aDTQOEQKOpwT5wpPb1RYDMIY";

function getOAuthClient(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const redirectUri = `${proto}://${host}/api/auth/callback`;

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

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

function getDriveClient(tokens) {
  if (tokens && (tokens.access_token || tokens.refresh_token)) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials(tokens);
    return google.drive({ version: "v3", auth: oauth2Client });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return google.drive({ version: "v3", auth: oauth2Client });
  }
  return null;
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
      config: {
        responseModalities: ["IMAGE", "TEXT"],
      },
    });

    const candidate = response.candidates?.[0];
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.inlineData?.data) {
          return part.inlineData.data;
        }
      }
    }
  } catch (err1) {
    console.warn("generateContent failed:", err1.message);
  }

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

    const imageBytes = result.generatedImages?.[0]?.image?.imageBytes;
    if (imageBytes) {
      return imageBytes;
    }
  } catch (err2) {
    throw new Error(err2.message || "Failed to generate image with Gemini API");
  }

  throw new Error("No image data returned from Gemini API");
}

export default async function handler(req, res) {
  const parsedUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;
  const cookies = parseCookies(req);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // OAuth Route 1: Initiate OAuth Login
  if (pathname === "/api/auth/login") {
    try {
      const oauth2 = getOAuthClient(req);
      const authUrl = oauth2.generateAuthUrl({
        access_type: "offline",
        scope: ["https://www.googleapis.com/auth/drive.file"],
        prompt: "consent",
      });
      res.writeHead(302, { Location: authUrl });
      res.end();
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("OAuth configuration error: " + err.message);
    }
    return;
  }

  // OAuth Route 2: Callback
  if (pathname === "/api/auth/callback") {
    const code = parsedUrl.searchParams.get("code");
    if (!code) {
      res.writeHead(302, { Location: "/?error=no_code" });
      res.end();
      return;
    }
    try {
      const oauth2 = getOAuthClient(req);
      const { tokens } = await oauth2.getToken(code);
      
      const cookieHeader = [
        `gdrive_access_token=${tokens.access_token || ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure`,
        `gdrive_refresh_token=${tokens.refresh_token || ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure`
      ];

      res.setHeader("Set-Cookie", cookieHeader);
      res.writeHead(302, { Location: "/?connected=true" });
      res.end();
    } catch (err) {
      console.error("Token exchange failed:", err);
      res.writeHead(302, { Location: `/?error=${encodeURIComponent(err.message)}` });
      res.end();
    }
    return;
  }

  // API 1: List Google Drive Gallery Files
  if (pathname === "/api/drive/files" && req.method === "GET") {
    try {
      const userTokens = {
        access_token: cookies.gdrive_access_token,
        refresh_token: cookies.gdrive_refresh_token
      };
      const drive = getDriveClient(userTokens);
      let files = [];
      if (drive) {
        const driveRes = await drive.files.list({
          q: `'${driveFolderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType, modifiedTime, size)",
          pageSize: 50,
          orderBy: "createdTime desc"
        });
        files = driveRes.data.files || [];
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ folderId: driveFolderId, files, connected: !!drive }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ folderId: driveFolderId, files: [], connected: false, error: err.message }));
    }
    return;
  }

  // API 2: Generate Image with Gemini / Imagen
  if (pathname === "/api/generate" && req.method === "POST") {
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
        if (uploadToDrive) {
          try {
            const userTokens = {
              access_token: cookies.gdrive_access_token,
              refresh_token: cookies.gdrive_refresh_token
            };
            const drive = getDriveClient(userTokens);
            if (drive) {
              const fileMetadata = { name: `img_${Date.now()}.jpg`, parents: [driveFolderId] };
              const { Readable } = await import("node:stream");
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
              driveResult = { success: true, driveFileId: file.data.id, folderId: driveFolderId };
            }
          } catch (driveErr) {
            console.error("Drive upload error:", driveErr);
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
    return;
  }

  // Serve Homepage
  const htmlPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(htmlPath)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(htmlPath).pipe(res);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}
