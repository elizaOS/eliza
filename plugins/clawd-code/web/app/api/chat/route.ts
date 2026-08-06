import { NextRequest, NextResponse } from "next/server";

// Mirrors clawd-code's CLI provider defaults (src/grok-models.ts) — Z.AI first.
const PROVIDER_ENV_KEYS: Record<string, string> = {
  zai: "ZAI_API_KEY",
  xai: "XAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const apiUrl =
      process.env.CLAWD_API_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      "http://localhost:3001";

    const provider: string = body.provider ?? "zai";
    const envKey = PROVIDER_ENV_KEYS[provider] ?? PROVIDER_ENV_KEYS.zai;
    // Client-supplied key (from settings) wins; falls back to the server's env var.
    const apiKey: string | undefined = body.apiKey || process.env[envKey];

    const response = await fetch(`${apiUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Clawd-Provider": provider,
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ ...body, provider, apiKey: undefined }),
    });

    if (!response.ok) {
      const contentType = response.headers.get("Content-Type") ?? "application/json";
      const text = await response.text();
      return new NextResponse(
        text || JSON.stringify({ error: "Backend request failed" }),
        {
          status: response.status,
          headers: { "Content-Type": contentType },
        }
      );
    }

    // Stream the response through
    return new NextResponse(response.body, {
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
