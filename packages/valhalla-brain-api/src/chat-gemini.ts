import { handleRequest as originalHandleRequest, BrainEnv, MemoryStore } from "./worker.ts";

export async function handleRequestWithGeminiChat(
  request: Request,
  store: MemoryStore,
  env: BrainEnv & { GEMINI_API_KEY?: string }
): Promise<Response> {
  const url = new URL(request.url);

  // Gemini Chat Integration Route: /v1/chat
  if (request.method === "POST" && url.pathname === "/v1/chat") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        prompt?: string;
        messages?: { role: string; content: string }[];
      };

      const userPrompt = body.prompt || (body.messages && body.messages.length > 0 ? body.messages[body.messages.length - 1].content : "");
      if (!userPrompt) {
        return new Response(JSON.stringify({ error: "Prompt or message is required" }), {
          status: 400,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
        });
      }

      const geminiKey = (env.GEMINI_API_KEY ?? "").trim() || (process.env.GEMINI_API_KEY ?? "").trim();
      if (!geminiKey) {
        return new Response(JSON.stringify({
          error: "The configured chat provider key is missing. (V-CHAT-CONFIG)",
          hint: "Set GEMINI_API_KEY in Cloudflare Worker secrets or via Merlin Setup on /os/"
        }), {
          status: 503,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
        });
      }

      // Call Google Gemini 2.0 Flash / Pro REST API
      const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
      const geminiRes = await fetch(geminiEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
        })
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        return new Response(JSON.stringify({ error: `Gemini API Error: ${errText}` }), {
          status: geminiRes.status,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
        });
      }

      const geminiData = (await geminiRes.json()) as any;
      const reply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";

      return new Response(JSON.stringify({ reply, provider: "gemini-2.0-flash", ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
      });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
      });
    }
  }

  return originalHandleRequest(request, store, env);
}
