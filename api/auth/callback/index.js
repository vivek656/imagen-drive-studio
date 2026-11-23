import { google } from "googleapis";

export default async function handler(req, res) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const redirectUri = `${proto}://${host}/api/auth/callback`;

  const parsedUrl = new URL(req.url, `${proto}://${host}`);
  const code = parsedUrl.searchParams.get("code");

  if (!code) {
    res.writeHead(302, { Location: "/?error=no_code" });
    res.end();
    return;
  }

  try {
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );
    const { tokens } = await oauth2.getToken(code);

    const cookieHeader = [
      `gdrive_access_token=${tokens.access_token || ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure`,
      `gdrive_refresh_token=${tokens.refresh_token || ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure`
    ];

    res.setHeader("Set-Cookie", cookieHeader);
    res.writeHead(302, { Location: "/?connected=true" });
    res.end();
  } catch (err) {
    res.writeHead(302, { Location: `/?error=${encodeURIComponent(err.message)}` });
    res.end();
  }
}
