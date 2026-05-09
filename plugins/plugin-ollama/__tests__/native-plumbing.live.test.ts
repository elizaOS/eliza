/**
 * Live e2e for the Ollama plugin's native plumbing path.
 *
 * Where the sibling shape file (`native-plumbing.shape.test.ts`) verifies that
 * the plugin builds the right call shape with the AI SDK boundary mocked, this
 * file boots against a real Ollama server and verifies that the shapes the
 * plugin builds actually round-trip through `ai` + `ollama-ai-provider-v2` and
 * produce sane output.
 *
 * Skip gate: requires `OLLAMA_API_ENDPOINT` (or `OLLAMA_API_URL`) pointing at a
 * reachable Ollama server. Set e.g. `OLLAMA_API_ENDPOINT=http://localhost:11434`
 * and run `ollama pull llama3.2:1b` (or set `OLLAMA_SMALL_MODEL` to a model you
 * already have) to enable.
 */
import type { GenerateTextResult, IAgentRuntime, TextStreamResult } from "@elizaos/core";
import { beforeAll, describe, expect, it } from "vitest";

import { handleTextSmall } from "../models/text";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const OLLAMA_ENDPOINT =
  process.env.OLLAMA_API_ENDPOINT?.trim() || process.env.OLLAMA_API_URL?.trim() || "";
const OLLAMA_SMALL_MODEL = process.env.OLLAMA_SMALL_MODEL?.trim() || "llama3.2:1b";

function createRuntime(): IAgentRuntime {
  const settings: Record<string, string> = {
    OLLAMA_API_ENDPOINT: OLLAMA_ENDPOINT,
    OLLAMA_SMALL_MODEL,
  };
  const runtime = {
    character: { system: "You are a concise test agent." },
    emitEvent: async () => undefined,
    getSetting: (key: string) => settings[key] ?? null,
  };

  return runtime as IAgentRuntime;
}

async function pingOllama(endpoint: string): Promise<boolean> {
  const base = endpoint.replace(/\/api\/?$/, "").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const skipReason = !OLLAMA_ENDPOINT
  ? "OLLAMA_API_ENDPOINT not set (set OLLAMA_API_ENDPOINT=http://localhost:11434 and `ollama pull llama3.2:1b` to enable)"
  : null;

if (skipReason) {
  process.env.SKIP_REASON ||= skipReason;
  console.warn(`${YELLOW}[ollama-live] skipped — ${skipReason}${RESET}`);
}

describe.skipIf(skipReason !== null)("Ollama native text plumbing (live)", () => {
  let serverReachable = false;

  beforeAll(async () => {
    serverReachable = await pingOllama(OLLAMA_ENDPOINT);
    if (!serverReachable) {
      console.warn(
        `${YELLOW}[ollama-live] OLLAMA_API_ENDPOINT=${OLLAMA_ENDPOINT} unreachable — tests will skip${RESET}`
      );
    }
  }, 5000);

  it("returns a string for a plain prompt", async () => {
    if (!serverReachable) return;
    const result = (await handleTextSmall(createRuntime(), {
      prompt: "Reply with exactly two words: live ready",
    } as never)) as string | GenerateTextResult;

    if (typeof result === "string") {
      expect(result.length).toBeGreaterThan(0);
    } else {
      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("accepts a messages-shaped request and returns non-empty output", async () => {
    if (!serverReachable) return;
    const result = (await handleTextSmall(createRuntime(), {
      messages: [{ role: "user", content: "Say the word 'ready' and nothing else." }],
    } as never)) as string | GenerateTextResult;

    const text = typeof result === "string" ? result : result.text;
    expect(typeof text).toBe("string");
    expect(text.trim().length).toBeGreaterThan(0);
  }, 60_000);

  it("streams chunks via streamText when stream=true (no tools, no schema)", async () => {
    if (!serverReachable) return;
    const result = (await handleTextSmall(createRuntime(), {
      prompt: "Count from 1 to 3, comma-separated, then stop.",
      stream: true,
    } as never)) as TextStreamResult;

    expect(result && typeof result === "object" && "textStream" in result).toBe(true);
    const chunks: string[] = [];
    for await (const c of result.textStream) {
      chunks.push(c);
    }
    expect(chunks.length).toBeGreaterThan(0);
    const joined = chunks.join("");
    expect(joined.trim().length).toBeGreaterThan(0);
    await expect(result.text).resolves.toEqual(expect.any(String));
  }, 60_000);
});
