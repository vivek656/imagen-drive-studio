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

export default async function handler(req, res) {
  const cookies = parseCookies(req);
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || "1RpfZGzJ0aDTQOEQKOpwT5wpPb1RYDMIY";

  const userTokens = {
    access_token: cookies.gdrive_access_token,
    refresh_token: cookies.gdrive_refresh_token
  };

  let drive = null;
  if (userTokens.access_token || userTokens.refresh_token) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials(userTokens);
    drive = google.drive({ version: "v3", auth: oauth2Client });
  }

  let files = [];
  if (drive) {
    try {
      const driveRes = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "files(id, name, mimeType, modifiedTime, size)",
        pageSize: 50,
        orderBy: "createdTime desc"
      });
      files = driveRes.data.files || [];
    } catch (_) {}
  }

  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify({ folderId, files, connected: !!drive }));
}
