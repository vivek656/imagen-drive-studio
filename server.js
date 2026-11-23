import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3080;
const PUBLIC_DIR = path.join(__dirname, "public");
const GENERATED_DIR = path.join(PUBLIC_DIR, "generated");
const DRIVE_FOLDER_NAME = "Imagen-AI-Gallery";

// Ensure dirs exist
if (!fs.existsSync(GENERATED_DIR)) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

// Drive configuration
let driveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || "1RpfZGzJ0aDTQOEQKOpwT5wpPb1RYDMIY";

function getDriveClient() {
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

// ─── Style Enhancement Wrappers ──────────────────────────────────
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

// ─── Drive API Helpers (Dual Mode: googleapis SDK or gdrive CLI) ───
async function listDriveFiles() {
  const drive = getDriveClient();
  if (drive) {
    const res = await drive.files.list({
      q: `'${driveFolderId}' in parents and trashed = false`,
      fields: "files(id, name, mimeType, modifiedTime, size)",
      pageSize: 50,
      orderBy: "createdTime desc"
    });
    return res.data.files || [];
  } else {
    // Fallback to local gdrive CLI
    const { stdout } = await execAsync(`gdrive readonly ls ${driveFolderId} --json`);
    return JSON.parse(stdout || "[]");
  }
}

async function uploadFileToDrive(filePath, fileName) {
  const drive = getDriveClient();
  if (drive) {
    const fileMetadata = {
      name: fileName,
      parents: [driveFolderId]
    };
    const media = {
      mimeType: "image/jpeg",
      body: fs.createReadStream(filePath)
    };
    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: "id, name, webViewLink"
    });

    // Make file viewable
    try {
      await drive.permissions.create({
        fileId: file.data.id,
        requestBody: { role: "reader", type: "anyone" }
      });
    } catch (_) {}

    return {
      success: true,
      driveFileId: file.data.id,
      folderId: driveFolderId,
      message: `Uploaded via Google Drive API (ID: ${file.data.id})`
    };
  } else {
    // Fallback to local gdrive CLI
    const cmd = `gdrive mutate upload "${filePath}" --parent "${driveFolderId}" --json`;
    const uploadExec = await execAsync(cmd);
    const idMatch = uploadExec.stdout.match(/ID:\s*([a-zA-Z0-9_-]+)/);
    const driveFileId = idMatch ? idMatch[1] : null;
    if (driveFileId) {
      await execAsync(`gdrive mutate share ${driveFileId} --role reader --type anyone --json`);
    }
    return {
      success: true,
      driveFileId,
      folderId: driveFolderId,
      message: uploadExec.stdout.trim()
    };
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // API 1: List Google Drive Gallery Files
  if (pathname === "/api/drive/files" && req.method === "GET") {
    try {
      const files = await listDriveFiles();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ folderId: driveFolderId, files, mode: getDriveClient() ? "googleapis_sdk" : "gdrive_cli" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API 2: Generate Image with Imagen 3
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
          res.end(JSON.stringify({ 
            error: "GEMINI_API_KEY is not provided. Please enter your Gemini API key in the UI or set the GEMINI_API_KEY environment variable." 
          }));
          return;
        }

        const ai = new GoogleGenAI({ apiKey: effectiveKey });
        const enhancedPrompt = enhancePrompt(prompt, style);
        console.log(`[Generate] Original: "${prompt}"`);
        console.log(`[Generate] Enhanced: "${enhancedPrompt}"`);

        const result = await ai.models.generateImages({
          model: "imagen-3.0-generate-002",
          prompt: enhancedPrompt,
          config: {
            numberOfImages: 1,
            outputMimeType: "image/jpeg",
            aspectRatio: aspectRatio,
            personGeneration: "ALLOW_ADULT",
          },
        });

        const imageBytes = result.generatedImages?.[0]?.image?.imageBytes;
        if (!imageBytes) {
          throw new Error("No image data returned from Imagen 3");
        }

        const fileName = `img_${Date.now()}.jpg`;
        const localFilePath = path.join(GENERATED_DIR, fileName);
        fs.writeFileSync(localFilePath, Buffer.from(imageBytes, "base64"));

        let driveResult = null;
        if (uploadToDrive) {
          try {
            driveResult = await uploadFileToDrive(localFilePath, fileName);
          } catch (driveErr) {
            console.error("Drive upload error:", driveErr);
            driveResult = { success: false, error: driveErr.message };
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          localUrl: `/generated/${fileName}`,
          dataUrl: `data:image/jpeg;base64,${imageBytes}`,
          driveResult,
          prompt,
          enhancedPrompt,
          style,
          aspectRatio
        }));

      } catch (err) {
        console.error("Generation error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || "Failed to generate image" }));
      }
    });
    return;
  }

  // Serve static files
  let safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml"
    };
    const contentType = mimeTypes[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
