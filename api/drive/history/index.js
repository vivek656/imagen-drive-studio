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
  const cookies = parseCookies(req);
  const userTokens = {
    access_token: cookies.gdrive_access_token,
    refresh_token: cookies.gdrive_refresh_token || process.env.GOOGLE_REFRESH_TOKEN
  };

  if (!userTokens.access_token && !userTokens.refresh_token) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ success: false, connected: false, history: [] }));
    return;
  }

  let drive = null;
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials(userTokens);
    drive = google.drive({ version: "v3", auth: oauth2Client });
  } catch (err) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(500);
    res.end(JSON.stringify({ success: false, error: err.message }));
    return;
  }

  const folderId = await getOrCreateGalleryFolder(drive);

  if (req.method === "GET") {
    try {
      let q = "name = 'chat_history.json' and trashed = false";
      if (folderId) {
        q = `'${folderId}' in parents and name = 'chat_history.json' and trashed = false`;
      }

      const listRes = await drive.files.list({
        q,
        fields: "files(id, name)",
        spaces: "drive"
      });

      if (!listRes.data.files || listRes.data.files.length === 0) {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, connected: true, history: [] }));
        return;
      }

      const fileId = listRes.data.files[0].id;
      const fileRes = await drive.files.get({
        fileId,
        alt: "media"
      });

      const historyData = typeof fileRes.data === "object" ? fileRes.data : JSON.parse(fileRes.data || "[]");

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, connected: true, history: historyData }));
    } catch (err) {
      console.error("Error reading chat history from Drive:", err.message);
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ success: false, connected: true, history: [], error: err.message }));
    }
  } else if (req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const history = payload.history || [];

        // Check if chat_history.json already exists
        let q = "name = 'chat_history.json' and trashed = false";
        if (folderId) {
          q = `'${folderId}' in parents and name = 'chat_history.json' and trashed = false`;
        }

        const listRes = await drive.files.list({
          q,
          fields: "files(id, name)",
          spaces: "drive"
        });

        const historyJson = JSON.stringify(history, null, 2);
        const mediaStream = new Readable();
        mediaStream.push(historyJson);
        mediaStream.push(null);

        if (listRes.data.files && listRes.data.files.length > 0) {
          // Update existing file
          const fileId = listRes.data.files[0].id;
          await drive.files.update({
            fileId,
            media: { mimeType: "application/json", body: mediaStream }
          });
        } else {
          // Create new file
          await drive.files.create({
            resource: {
              name: "chat_history.json",
              ...(folderId ? { parents: [folderId] } : {})
            },
            media: { mimeType: "application/json", body: mediaStream },
            fields: "id, name"
          });
        }

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error("Error saving chat history to Drive:", err.message);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  } else {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(405);
    res.end(JSON.stringify({ error: "Method not allowed" }));
  }
}
