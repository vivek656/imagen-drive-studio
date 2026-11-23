import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3080;

import generateHandler from "./api/generate/index.js";
import chatHandler from "./api/chat/index.js";
import driveFilesHandler from "./api/drive/files/index.js";
import driveHistoryHandler from "./api/drive/history/index.js";
import authLoginHandler from "./api/auth/login/index.js";
import authCallbackHandler from "./api/auth/callback/index.js";
import authLogoutHandler from "./api/auth/logout/index.js";

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // API Routes
  if (pathname === "/api/chat") {
    return chatHandler(req, res);
  }
  if (pathname === "/api/generate") {
    return generateHandler(req, res);
  }
  if (pathname === "/api/drive/files") {
    return driveFilesHandler(req, res);
  }
  if (pathname === "/api/drive/history") {
    return driveHistoryHandler(req, res);
  }
  if (pathname === "/api/auth/login") {
    return authLoginHandler(req, res);
  }
  if (pathname === "/api/auth/callback") {
    return authCallbackHandler(req, res);
  }
  if (pathname === "/api/auth/logout") {
    return authLogoutHandler(req, res);
  }

  // Static File Serving
  let filePath = path.join(__dirname, "public", pathname === "/" ? "index.html" : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, "public", "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
  };
  const contentType = mimeTypes[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end("Internal Server Error");
    } else {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache, no-store, must-revalidate"
      });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
