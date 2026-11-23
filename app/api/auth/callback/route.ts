import { google } from "googleapis";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const origin = url.origin;
  const redirectUri = `${origin}/api/auth/callback`;

  if (!code) {
    return NextResponse.redirect(`${origin}/?error=no_code`);
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );

    const { tokens } = await oauth2Client.getToken(code);

    // Store tokens in an HTTP-only secure cookie or session
    const response = NextResponse.redirect(`${origin}/?connected=true`);
    
    if (tokens.refresh_token) {
      response.cookies.set("gdrive_refresh_token", tokens.refresh_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365, // 1 year
      });
    }

    if (tokens.access_token) {
      response.cookies.set("gdrive_access_token", tokens.access_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 3600, // 1 hour
      });
    }

    return response;
  } catch (err: any) {
    console.error("OAuth callback error:", err);
    return NextResponse.redirect(`${origin}/?error=${encodeURIComponent(err.message)}`);
  }
}
