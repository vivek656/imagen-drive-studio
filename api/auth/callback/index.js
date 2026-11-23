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

    const isLocalhost = host.includes("localhost");
    const secureFlag = isLocalhost ? "" : "; Secure";

    const existingCookies = parseCookies(req);
    const refreshToken = tokens.refresh_token || existingCookies.gdrive_refresh_token || "";

    // Store tokens in cookies readable across requests
    const cookieHeader = [
      `gdrive_access_token=${tokens.access_token || ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${secureFlag}`,
      `gdrive_refresh_token=${refreshToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secureFlag}`,
      `gdrive_connected=true; Path=/; SameSite=Lax; Max-Age=31536000${secureFlag}`
    ];

    res.setHeader("Set-Cookie", cookieHeader);
    res.writeHead(302, { Location: "/?connected=true" });
    res.end();
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.writeHead(302, { Location: `/?error=${encodeURIComponent(err.message)}` });
    res.end();
  }
}
