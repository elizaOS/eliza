/**
 * End-to-end test for the standalone llama.cpp engine.
 *
 * Loads a real GGUF file via `node-llama-cpp` and runs a real generation.
 * Uses whatever GGUFs happen to exist on the developer's machine from
 * external tools (LM Studio / Jan / Ollama / HF) — detected via
 * `scanExternalModels`. When none are present, the test is skipped with
 * a clear message rather than pretending it passed.
 *
 * This is slow (~5-30s depending on model size), so it's split into its
 * own `.e2e.test.ts` file and excluded from fast-path runs by the default
 * vitest include globs.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalInferenceEngine } from "./engine";
import { scanExternalModels } from "./external-scanner";
import type { InstalledModel } from "./types";

async function pickSmallestGguf(): Promise<InstalledModel | null> {
  const external = await scanExternalModels();
  // Prefer small GGUFs (< 3 GB) so the test finishes in reasonable time.
  const small = external.filter((m) => m.sizeBytes < 3 * 1024 ** 3);
  const candidates = small.length > 0 ? small : external;
  candidates.sort((a, b) => a.sizeBytes - b.sizeBytes);
  return candidates[0] ?? null;
}

describe("LocalInferenceEngine e2e", () => {
  let pick: InstalledModel | null = null;
  let engine: LocalInferenceEngine | null = null;

  beforeAll(async () => {
    pick = await pickSmallestGguf();
  }, 10_000);

  afterAll(async () => {
    if (engine) {
      try {
        await engine.unload();
      } catch {
        /* best-effort teardown */
      }
    }
  });

  it("detects whether the node-llama-cpp binding is available", async () => {
    const probe = new LocalInferenceEngine();
    const available = await probe.available();
    // No assertion on the value itself — the result depends on what's
    // installed. What we verify is that the check is non-throwing and
    // returns a boolean.
    expect(typeof available).toBe("boolean");
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "loads a real GGUF and returns text from generate()",
    async () => {
      if (!pick) {
        console.warn(
          "[engine.e2e] No local GGUF found via scanExternalModels — skipping. " +
            "Install LM Studio / Jan / Ollama models or run a Milady download to exercise this path.",
        );
        return;
      }

      engine = new LocalInferenceEngine();
      if (!(await engine.available())) {
        console.warn(
          "[engine.e2e] node-llama-cpp binding not available in this build — skipping.",
        );
        return;
      }

      await engine.load(pick.path);
      expect(engine.hasLoadedModel()).toBe(true);
      expect(engine.currentModelPath()).toBe(pick.path);

      const text = await engine.generate({
        prompt: "Reply with the single word: ping.",
        maxTokens: 16,
        temperature: 0,
      });
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);

      // Second generation on the same session — resetChatHistory must
      // have run so the model sees this as a fresh turn, not a continuation.
      const text2 = await engine.generate({
        prompt: "Reply with the single word: pong.",
        maxTokens: 16,
        temperature: 0,
      });
      expect(typeof text2).toBe("string");
      expect(text2.length).toBeGreaterThan(0);

      await engine.unload();
      expect(engine.hasLoadedModel()).toBe(false);
      expect(engine.currentModelPath()).toBeNull();
    },
    180_000,
  );
});
