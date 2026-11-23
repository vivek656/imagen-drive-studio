import { google } from "googleapis";

export default function handler(req, res) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const isLocal = host.includes("localhost") || host.includes("127.0.0.1");
  const proto = req.headers["x-forwarded-proto"] || (isLocal ? "http" : "https");
  const redirectUri = `${proto}://${host}/api/auth/callback`;

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/drive.file"],
    prompt: "consent",
  });

  res.writeHead(302, { Location: authUrl });
  res.end();
}
