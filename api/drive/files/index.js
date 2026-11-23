import { google } from "googleapis";

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

  let drive = null;
  if (userTokens.access_token || userTokens.refresh_token) {
    try {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );
      oauth2Client.setCredentials(userTokens);
      drive = google.drive({ version: "v3", auth: oauth2Client });
    } catch (authErr) {
      console.error("Auth init error:", authErr.message);
    }
  }

  let files = [];
  let folderId = null;

  if (drive) {
    try {
      folderId = await getOrCreateGalleryFolder(drive);

      let q = "mimeType contains 'image/' and trashed = false";
      if (folderId) {
        q = `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`;
      }

      const driveRes = await drive.files.list({
        q,
        fields: "files(id, name, mimeType, modifiedTime, size, thumbnailLink, webViewLink, webContentLink)",
        pageSize: 60,
        orderBy: "createdTime desc"
      });
      files = driveRes.data.files || [];
    } catch (listErr) {
      console.error("Failed to list files from Drive:", listErr.message);
    }
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.writeHead(200);
  res.end(JSON.stringify({ folderId, files, connected: !!drive }));
}
