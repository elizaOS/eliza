/**
 * End-to-end test for the standalone llama.cpp engine.
 *
 * Imports the engine directly, loads a real GGUF from disk, and runs a
 * real generation. This file is intended for Bun's test runner, which
 * can load the native node-llama-cpp module in-process.
 *
 * Gracefully skips when no GGUF is present on the machine (scanned
 * from LM Studio / Jan / Ollama / HF caches).
 */

import { describe, expect, it } from "vitest";
import { scanExternalModels } from "./external-scanner";
import type { InstalledModel } from "./types";

interface EngineResult {
  ok: boolean;
  generatedText?: string;
  generatedText2?: string;
  error?: string;
}

const UNSUPPORTED_TEXT_E2E_MODEL_PATTERNS = [
  /\bmoondream\b/i,
  /\bvision\b/i,
  /\bclip\b/i,
  /\bembed(?:ding)?\b/i,
  /\bdeepseek-r1\b/i,
  /\bgemma/i,
];

function isTextGenerationCandidate(model: InstalledModel): boolean {
  const searchable = `${model.id} ${model.displayName} ${model.path}`;
  return !UNSUPPORTED_TEXT_E2E_MODEL_PATTERNS.some((pattern) =>
    pattern.test(searchable),
  );
}

async function pickSmallestGguf(): Promise<InstalledModel | null> {
  const external = await scanExternalModels();
  // Chat models small enough to load quickly but big enough to actually
  // be chat models. Under ~500 MB is typically an embedding model or
  // tokenizer blob — wrong shape for generation.
  const usable = external.filter(
    (m) =>
      m.sizeBytes >= 600 * 1024 ** 2 &&
      m.sizeBytes < 3 * 1024 ** 3 &&
      isTextGenerationCandidate(m),
  );
  usable.sort((a, b) => a.sizeBytes - b.sizeBytes);
  return usable[0] ?? null;
}

async function runEngine(modelPath: string): Promise<EngineResult> {
  const { LocalInferenceEngine } = await import("./engine");
  const engine = new LocalInferenceEngine();
  try {
    await engine.load(modelPath);
    const text = await engine.generate({
      prompt: "Say hello.",
      maxTokens: 64,
      temperature: 0.2,
    });
    const text2 = await engine.generate({
      prompt: "What is 2+2?",
      maxTokens: 64,
      temperature: 0.2,
    });
    await engine.unload();
    return {
      ok: true,
      generatedText: text,
      generatedText2: text2,
    };
  } catch (err) {
    await engine.unload().catch(() => undefined);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("LocalInferenceEngine e2e (real GGUF, real inference)", () => {
  it("loads a GGUF and produces generated text", async () => {
    const pick = await pickSmallestGguf();
    console.log(
      `[engine.e2e] HOME=${process.env.HOME} cwd=${process.cwd()} pick=${pick?.path ?? "null"}`,
    );
    if (!pick) {
      console.warn(
        "[engine.e2e] No local GGUF found. Install an LM Studio / Jan / Ollama model, or run a real Eliza download, to exercise this path.",
      );
      return;
    }
    console.log(
      `[engine.e2e] Using ${pick.externalOrigin} model at ${pick.path} (${(pick.sizeBytes / 1024 ** 3).toFixed(2)} GB)`,
    );

    const result = await runEngine(pick.path);
    if (!result.ok) {
      throw new Error(`engine failed: ${result.error}`);
    }
    console.log(
      `[engine.e2e] "Say hello." → ${JSON.stringify(result.generatedText)}`,
    );
    console.log(
      `[engine.e2e] "What is 2+2?" → ${JSON.stringify(result.generatedText2)}`,
    );
    expect(typeof result.generatedText).toBe("string");
    expect((result.generatedText ?? "").length).toBeGreaterThan(0);
    expect(typeof result.generatedText2).toBe("string");
    expect((result.generatedText2 ?? "").length).toBeGreaterThan(0);
  }, 300_000);
});
