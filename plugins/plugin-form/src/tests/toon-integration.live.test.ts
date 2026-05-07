import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(testDir, "../../../../../.env") });

let callLLM: (prompt: string) => Promise<string>;
let hasApiKey = false;

try {
  if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    hasApiKey = true;
    callLLM = async (prompt: string) => {
      const msg = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      });
      return msg.content[0].type === "text" ? msg.content[0].text : "";
    };
  } else if (process.env.OPENAI_API_KEY) {
    const { default: OpenAI } = await import("openai");
    const baseURL = process.env.OPENAI_BASE_URL || undefined;
    const isGroq = (() => {
      if (!baseURL) return false;
      try {
        const host = new URL(baseURL).hostname;
        return host === "groq.com" || host.endsWith(".groq.com");
      } catch {
        return false;
      }
    })();
    const client = new OpenAI({ baseURL });
    hasApiKey = true;
    callLLM = async (prompt: string) => {
      const resp = await client.chat.completions.create({
        model: isGroq ? "llama-3.3-70b-versatile" : "gpt-4o-mini",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      });
      return resp.choices[0]?.message?.content ?? "";
    };
  }
} catch {
  // SDK not available
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error("No JSON object found");
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as Record<
    string,
    unknown
  >;
}

describe.skipIf(!hasApiKey)("JSON form field extraction integration", () => {
  it("extracts a single field from a user message", async () => {
    const prompt = `Extract the following field from the user's message.

Field: email
Label: Email Address
Description: The user's email address
Required: true

User message: "My email is john@example.com and I'd like to sign up"

Respond using JSON like this:
{
  "found": true,
  "value": "extracted value or empty",
  "confidence": 0.95
}

IMPORTANT: Your response must ONLY contain the JSON object above. No preamble or explanation.`;

    const raw = await callLLM(prompt);
    const parsed = parseJsonObject(raw);

    expect(parsed).not.toBeNull();
    expect(String(parsed?.found)).toBe("true");
    expect(String(parsed?.value)).toContain("john@example.com");
    const confidence = Number(parsed?.confidence);
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  }, 30_000);
});
