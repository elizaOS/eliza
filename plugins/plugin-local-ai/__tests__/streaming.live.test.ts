/**
 * Live streaming smoke test against a real local GGUF model.
 *
 * Gated — only runs when one of:
 *   - `LOCAL_AI_TEST_MODEL` env var points at a readable `.gguf` file, or
 *   - the default small model is present at
 *     `~/.eliza/models/text/eliza-1-2b-32k.gguf` (or the
 *     legacy `~/.milady/models/...` path).
 *
 * Loads the real model via `node-llama-cpp`, runs a short prompt, and
 * asserts that the streaming adapter delivers at least two deltas before
 * the prompt completes — i.e. the engine is actually emitting per-token.
 *
 * The plugin's local `vitest.config.ts` does not load the global
 * `fail-on-silent-skip` setup, so a `describe.skipIf(!hasModel)` skip
 * does not break the run.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TokenUsage } from "@elizaos/core";
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { describe, expect, it } from "vitest";
import { streamLlamaPrompt } from "../text-streaming.js";

function resolveTestModelPath(): string | undefined {
  const explicit = process.env.LOCAL_AI_TEST_MODEL?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  const candidates = [
    path.join(os.homedir(), ".eliza", "models", "text", "eliza-1-2b-32k.gguf"),
    path.join(os.homedir(), ".milady", "models", "text", "eliza-1-2b-32k.gguf"),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

const MODEL_PATH = resolveTestModelPath();
const HAS_MODEL = MODEL_PATH !== undefined;

describe.skipIf(!HAS_MODEL)("streamLlamaPrompt (live)", () => {
  it("emits >= 2 deltas before the prompt resolves", async () => {
    if (!MODEL_PATH) throw new Error("unreachable: skipped when MODEL_PATH is undefined");

    const llama = await getLlama();
    const model = await llama.loadModel({
      modelPath: MODEL_PATH,
      gpuLayers: 0, // CPU is enough for a smoke test; avoids GPU contention in CI.
      vocabOnly: false,
    });
    const context = await model.createContext({ contextSize: 2048 });
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: "You are a helpful assistant.",
    });

    const deltas: string[] = [];
    const result = streamLlamaPrompt({
      session,
      prompt: "Count to five, one number per line.",
      options: { maxTokens: 64, temperature: 0.2 },
      onChunk: (delta) => deltas.push(delta),
      estimateUsage: (_p, fullText): TokenUsage => ({
        promptTokens: 8,
        completionTokens: Math.ceil(fullText.length / 4),
        totalTokens: 8 + Math.ceil(fullText.length / 4),
      }),
    });

    const collected: string[] = [];
    for await (const delta of result.textStream) {
      collected.push(delta);
    }
    const finalText = await result.text;

    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(collected.length).toBeGreaterThanOrEqual(2);
    expect(finalText.length).toBeGreaterThan(0);
    await expect(result.finishReason).resolves.toBe("stop");

    try {
      context.dispose();
    } catch {
      /* best effort cleanup */
    }
  }, 120_000);
});

describe.skipIf(HAS_MODEL)("streamLlamaPrompt (live) - skipped", () => {
  it("skipped: no local GGUF model found", () => {
    // Marker test so the suite reports a passing run when no model is
    // installed. Without this, vitest reports "no tests found" if the
    // gated `describe` is the only one in the file and gets skipped.
    expect(HAS_MODEL).toBe(false);
  });
});
