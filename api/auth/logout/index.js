export default function handler(req, res) {
  // Clear the Google Drive OAuth cookies
  const clearCookies = [
    "gdrive_access_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    "gdrive_refresh_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"
  ];

  res.setHeader("Set-Cookie", clearCookies);
  res.writeHead(302, { Location: "/?disconnected=true" });
  res.end();
}
