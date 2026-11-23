export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", async () => {
    try {
      const data = JSON.parse(body || "{}");
      const { message, messages = [], model = "gemini-2.5-flash" } = data;

      if (!message && (!messages || messages.length === 0)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Message is required" }));
        return;
      }

      const apiKey = process.env.GEMINI_API_KEY;

      // Prepare conversation contents for Gemini
      const contents = [];
      const recentMessages = messages.slice(-10);

      for (const m of recentMessages) {
        if (m.type === "user" && m.prompt) {
          contents.push({ role: "user", parts: [{ text: m.prompt }] });
        } else if (m.type === "ai" && m.text) {
          contents.push({ role: "model", parts: [{ text: m.text }] });
        }
      }

      if (contents.length === 0 || contents[contents.length - 1].parts[0].text !== message) {
        contents.push({ role: "user", parts: [{ text: message }] });
      }

      const candidateModels = [model, "gemini-3-flash-preview", "gemini-2.5-flash"];
      let replyText = "";
      let usedModel = "";

      if (apiKey) {
        for (const targetModel of candidateModels) {
          try {
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 9000);

            const geminiRes = await fetch(geminiUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents,
                systemInstruction: {
                  parts: [{
                    text: "You are an intelligent, creative AI assistant inside Imagen & Gemini Studio. You help users with conversation, brainstorming, writing, and crafting rich, vivid image prompts. Be helpful, concise, and friendly. If a user asks you to create or generate an image, give them an inspiring prompt and remind them they can hit the Image button to render it."
                  }]
                }
              }),
              signal: controller.signal
            });
            clearTimeout(timer);

            if (geminiRes.ok) {
              const geminiData = await geminiRes.json();
              replyText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
              if (replyText) {
                usedModel = targetModel;
                break;
              }
            }
          } catch (err) {
            console.warn(`Model ${targetModel} attempt failed:`, err.message);
          }
        }
      }

      // Fallback if all Gemini models failed or no key
      if (!replyText) {
        const pollRes = await fetch(`https://text.pollinations.ai/${encodeURIComponent(message)}`);
        if (pollRes.ok) {
          replyText = await pollRes.text();
          usedModel = "fallback-text";
        } else {
          replyText = "I'm here to chat or generate images! Type any question or switch to Image mode to generate high-res art.";
        }
      }

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      });
      res.end(JSON.stringify({ success: true, reply: replyText, model: usedModel }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message || "Chat failed" }));
    }
  });
}
