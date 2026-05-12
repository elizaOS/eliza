/**
 * Tiny Cerebras client used by the pump.fun launcher to convert a free-form
 * user brief into structured token metadata. Talks directly to Cerebras's
 * OpenAI-compatible chat endpoint — no agent runtime, no plugin-openai. The
 * point of this script is to validate the wallet/browser stack, so the LLM
 * surface is intentionally minimal.
 */

export interface TokenMeta {
  name: string;
  symbol: string;
  description: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export async function decideTokenMeta(opts: {
  brief: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): Promise<TokenMeta> {
  const baseUrl = opts.baseUrl ?? "https://api.cerebras.ai/v1";
  const model = opts.model ?? "gpt-oss-120b";

  const system =
    "Return ONLY a JSON object with keys: name (1-24 chars), symbol (2-8 uppercase), " +
    "description (1-500 chars), and optionally twitter/telegram/website (full URLs only). No prose, no code fences.";

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: opts.brief },
      ],
      max_tokens: 1000,
      temperature: 0.8,
      response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Cerebras ${resp.status}: ${text.slice(0, 300)}`);
  }
  const json = (await resp.json()) as {
    choices?: Array<{
      message?: { content?: string; reasoning?: string };
    }>;
  };
  const message = json.choices?.[0]?.message;
  // gpt-oss models split reasoning + content; sometimes content is empty when
  // reasoning eats the budget. Fall back to extracting a JSON object from
  // whichever field is non-empty.
  const candidates = [message?.content, message?.reasoning].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
  let parsed: TokenMeta | null = null;
  for (const candidate of candidates) {
    const stripped = candidate
      .replace(/^```(?:json)?\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim();
    // Try direct JSON.parse first
    try {
      parsed = JSON.parse(stripped) as TokenMeta;
      break;
    } catch {
      // Fall back to first {...} block
      const m = stripped.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]) as TokenMeta;
          break;
        } catch {
          // try next candidate
        }
      }
    }
  }
  if (!parsed) {
    throw new Error(
      `Cerebras returned no parseable JSON. content=${(message?.content ?? "").slice(0, 120)} reasoning=${(message?.reasoning ?? "").slice(0, 120)}`,
    );
  }
  if (typeof parsed.name !== "string" || typeof parsed.symbol !== "string") {
    throw new Error("Cerebras output missing required name/symbol");
  }
  // sanitize
  parsed.name = parsed.name.trim().slice(0, 24);
  parsed.symbol = parsed.symbol
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  parsed.description = (parsed.description ?? "").trim().slice(0, 500);
  return parsed;
}
