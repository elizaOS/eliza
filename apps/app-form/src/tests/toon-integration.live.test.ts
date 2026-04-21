import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseKeyValueXml } from "@elizaos/core";
import { config } from "dotenv";

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
    const isGroq = baseURL?.includes("groq.com");
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

describe.skipIf(!hasApiKey)("TOON form field extraction integration", () => {
  it(
    "extracts a single field from a user message",
    async () => {
      const prompt = `Extract the following field from the user's message.

Field: email
Label: Email Address
Description: The user's email address
Required: true

User message: "My email is john@example.com and I'd like to sign up"

Respond using TOON like this:
found: true or false
value: extracted value or empty
confidence: 0.0 to 1.0

IMPORTANT: Your response must ONLY contain the TOON document above. No preamble or explanation.`;

      const raw = await callLLM(prompt);
      const parsed = parseKeyValueXml(raw);

      expect(parsed).not.toBeNull();
      expect(String(parsed?.found)).toBe("true");
      expect(String(parsed?.value)).toContain("john@example.com");
      const confidence = Number(parsed?.confidence);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    },
    30_000,
  );
});
