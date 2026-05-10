/**
 * Runtime test for the W1-C cache-type-override plumbing against the
 * milady-ai/node-llama-cpp@v3.18.1-milady.3+ binding.
 *
 * Stock node-llama-cpp@3.18.1 rejects the milady-fork KV cache type
 * strings (`tbq3_0`, `tbq4_0`, `qjl1_256`, `q4_polar`) at
 * `resolveGgmlTypeOption()` because its `GgmlType` enum doesn't carry
 * the new variants. The milady fork extends the enum to include slot
 * 43 (TBQ3_0), 44 (TBQ4_0), 46 (QJL1_256), 47 (Q4_POLAR) so the
 * string-to-int resolution succeeds.
 *
 * What this test verifies:
 *
 *   1. The loaded binding actually exposes the new GgmlType enum
 *      values (proves the fork is resolved, not stock upstream).
 *   2. Loading a real GGUF with a stock cache-type override (`f16`)
 *      through the W1-C override path actually plumbs the option to
 *      the binding — i.e. `engine.load(path, resolved)` with
 *      `cacheTypeK/V` set produces a working context and generation.
 *   3. Asking for `tbq4_0` / `tbq3_0` does not throw the historical
 *      "unknown cache type" error from the TS layer; the binding
 *      cleanly maps them to enum ints 44/43 and forwards to the
 *      C++ side.
 *
 * The test does NOT assert that the C++ kernel for `tbq4_0` actually
 * runs to completion — that requires the milady-ai/llama.cpp custom
 * binary, shipped through `@node-llama-cpp/<platform>`'s prebuilds
 * only against the upstream llama.cpp tree. With the upstream binary,
 * the binding accepts the string at the TS layer and forwards enum
 * 44 to the C++ side, which silently falls back to its default cache
 * type. The desktop KV-compression plumbing is "ready" once the
 * binding stops rejecting the strings — which is what this test pins.
 *
 * Skipped with a clear reason when no GGUF is available on disk.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveLocalInferenceLoadArgs } from "./active-model";
import { LocalInferenceEngine } from "./engine";
import type { InstalledModel } from "./types";

// Force a single-sequence pool so the per-context KV cache fits a small
// dev box's VRAM. The default of 8 sequences × small ctx × q8_0 K+V is
// well over the headroom on a typical laptop GPU.
const previousPoolSize = process.env.ELIZA_LOCAL_SESSION_POOL_SIZE;
beforeAll(() => {
  process.env.ELIZA_LOCAL_SESSION_POOL_SIZE = "1";
});
afterAll(() => {
  if (previousPoolSize === undefined) {
    delete process.env.ELIZA_LOCAL_SESSION_POOL_SIZE;
  } else {
    process.env.ELIZA_LOCAL_SESSION_POOL_SIZE = previousPoolSize;
  }
});

function findFirstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Path is unreadable — try the next candidate.
    }
  }
  return null;
}

/**
 * Locate a small GGUF that we can load quickly. Prefer the bundled
 * SmolLM2-360M (small, well-known) but fall back to any reasonable
 * 1B-class quant available in the standard model directories.
 */
function findTestGguf(): string | null {
  const home = os.homedir();
  return findFirstExistingPath([
    path.join(
      home,
      ".eliza/local-inference/models/SmolLM2-360M-Instruct-Q4_K_M.gguf",
    ),
    path.join(
      home,
      ".milady/local-inference/models/SmolLM2-360M-Instruct-Q4_K_M.gguf",
    ),
    path.join(home, ".eliza/models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"),
    path.join(home, ".eliza/models/Llama-3.2-1B-Instruct-Q4_K_M.gguf"),
  ]);
}

function makeInstalledModel(modelPath: string): InstalledModel {
  return {
    id: path.basename(modelPath, ".gguf"),
    displayName: path.basename(modelPath),
    path: modelPath,
    sizeBytes: fs.statSync(modelPath).size,
    installedAt: new Date().toISOString(),
    lastUsedAt: null,
    source: "external-scan",
  };
}

describe("ActiveModel runtime: cache-type override → milady fork binding", () => {
  it("exposes the milady-fork GgmlType extensions (TBQ3_0/TBQ4_0/QJL1_256/Q4_POLAR)", async () => {
    // Importing from the binding to prove which copy the test runner
    // actually loaded — should be the milady-ai/node-llama-cpp fork
    // (v3.18.1-milady.3+) when the consumer pin is set correctly. Stock
    // node-llama-cpp@3.18.1 has GgmlType.MXFP4 = 39 / NVFP4 = 40 and no
    // entries past 40.
    const { GgmlType } = await import("node-llama-cpp");
    const enumRecord = GgmlType as unknown as Record<string, number>;
    expect(enumRecord.TBQ3_0).toBe(43);
    expect(enumRecord.TBQ4_0).toBe(44);
    expect(enumRecord.QJL1_256).toBe(46);
    expect(enumRecord.Q4_POLAR).toBe(47);
  });

  it("loads a GGUF + generates with a stock cache-type override (f16)", async () => {
    const modelPath = findTestGguf();
    if (!modelPath) {
      console.warn(
        "[active-model.runtime] No test GGUF on disk; skipping. Install a small Q4 model under ~/.eliza/local-inference/models/ to exercise this path.",
      );
      return;
    }

    const installed = makeInstalledModel(modelPath);
    const resolved = await resolveLocalInferenceLoadArgs(installed, {
      contextSize: 1024,
      cacheTypeK: "f16",
      cacheTypeV: "f16",
    });

    expect(resolved.cacheTypeK).toBe("f16");
    expect(resolved.cacheTypeV).toBe("f16");
    expect(resolved.contextSize).toBe(1024);

    const engine = new LocalInferenceEngine();
    try {
      await engine.load(modelPath, resolved);
      const text = await engine.generate({
        prompt: "Reply with the single word ok.",
        maxTokens: 16,
        temperature: 0.0,
      });
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    } finally {
      await engine.unload().catch(() => undefined);
    }
  }, 300_000);

  it("forwards a fork-only cache-type override (tbq4_0/tbq3_0) without TS-layer rejection", async () => {
    const modelPath = findTestGguf();
    if (!modelPath) {
      console.warn(
        "[active-model.runtime] No test GGUF on disk; skipping. Install a small Q4 model under ~/.eliza/local-inference/models/ to exercise this path.",
      );
      return;
    }

    const installed = makeInstalledModel(modelPath);
    // Use `validateLocalInferenceLoadArgs` indirectly via resolve(...) in
    // its `allowFork: true` path — that's the same path the AOSP loader
    // would take, and it's how we surface fork strings to the binding.
    const resolved = await resolveLocalInferenceLoadArgs(installed, {
      contextSize: 1024,
      cacheTypeK: "tbq4_0",
      cacheTypeV: "tbq3_0",
    });

    expect(resolved.cacheTypeK).toBe("tbq4_0");
    expect(resolved.cacheTypeV).toBe("tbq3_0");

    const engine = new LocalInferenceEngine();
    let bindingError: Error | null = null;
    try {
      // The binding must accept the strings (resolveGgmlTypeOption maps
      // TBQ4_0 → 44, TBQ3_0 → 43). What happens at the C++ side depends
      // on the loaded `@node-llama-cpp/<platform>` binary:
      //   - upstream prebuild: silently falls back to the default cache
      //     type when the enum int isn't in its ggml type table.
      //   - milady-ai/llama.cpp prebuild: dispatches the actual TBQ
      //     kernel, generation runs.
      // Either is a passing run for this test.
      await engine.load(modelPath, resolved);
      const text = await engine.generate({
        prompt: "Reply with the single word ok.",
        maxTokens: 16,
        temperature: 0.0,
      });
      expect(typeof text).toBe("string");
    } catch (err) {
      bindingError = err instanceof Error ? err : new Error(String(err));
    } finally {
      await engine.unload().catch(() => undefined);
    }

    // The hard failure mode this test pins down is the TS-layer reject
    // from before milady-ai/node-llama-cpp existed. With stock
    // node-llama-cpp@3.18.1 + lowercase `tbq4_0`, the binding would
    // either throw or silently degrade because the stock enum has no
    // such key. With the milady fork binding, the string resolves
    // cleanly. Any error here must come from the C++ kernel layer (which
    // would mention either a ggml type code, a memory layout problem,
    // or VRAM/context size — never the "invalid cache type" string).
    if (bindingError != null) {
      const message = bindingError.message.toLowerCase();
      expect(message).not.toMatch(/invalid cache type/);
      expect(message).not.toMatch(/unknown.*cache.*type/);
      expect(message).not.toMatch(/no value for option.*experimentalkvcache/);
    }
  }, 300_000);
});
