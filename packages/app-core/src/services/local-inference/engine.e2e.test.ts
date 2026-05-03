/**
 * End-to-end test for the standalone llama.cpp engine.
 *
 * Spawns a separate `bun run` child process that imports the engine
 * directly (no Vite transform), loads a real GGUF from disk, and runs a
 * real generation. Asserts on the child's stdout JSON.
 *
 * Running out-of-process is deliberate: Vite's SSR loader mangles
 * node-native dynamic imports, so running under vitest's in-process
 * runner can't load `node-llama-cpp` reliably. The subprocess path
 * mirrors production exactly.
 *
 * Gracefully skips when no GGUF is present on the machine (scanned
 * from LM Studio / Jan / Ollama / HF caches).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanExternalModels } from "./external-scanner";
import type { InstalledModel } from "./types";

interface ChildResult {
  ok: boolean;
  generatedText?: string;
  generatedText2?: string;
  error?: string;
}

async function pickSmallestGguf(): Promise<InstalledModel | null> {
  const external = await scanExternalModels();
  // Chat models small enough to load quickly but big enough to actually
  // be chat models. Under ~500 MB is typically an embedding model or
  // tokenizer blob — wrong shape for generation.
  const usable = external.filter(
    (m) => m.sizeBytes >= 600 * 1024 ** 2 && m.sizeBytes < 3 * 1024 ** 3,
  );
  usable.sort((a, b) => a.sizeBytes - b.sizeBytes);
  return usable[0] ?? null;
}

function runChild(script: string, modelPath: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["-e", script], {
      env: { ...process.env, ELIZA_E2E_MODEL_PATH: modelPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `child exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
        return;
      }
      // Last line is the JSON result; ignore noisy llama.cpp logs above it.
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      const last = lines[lines.length - 1];
      if (!last) {
        reject(new Error(`empty child stdout\nstderr: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(last) as ChildResult);
      } catch (err) {
        reject(
          new Error(
            `child stdout not JSON: ${last}\nfull: ${stdout}\nstderr: ${stderr}\n${String(err)}`,
          ),
        );
      }
    });
    child.on("error", reject);
  });
}

const ENGINE_MODULE = path.resolve(__dirname, "engine.ts");

const CHILD_SCRIPT = `
import { LocalInferenceEngine } from ${JSON.stringify(ENGINE_MODULE)};
const modelPath = process.env.ELIZA_E2E_MODEL_PATH;
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
  console.log(JSON.stringify({
    ok: true,
    generatedText: text,
    generatedText2: text2,
    text1Len: text.length,
    text2Len: text2.length,
  }));
} catch (err) {
  console.log(JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  }));
}
`;

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

    const result = await runChild(CHILD_SCRIPT, pick.path);
    if (!result.ok) {
      throw new Error(`engine child failed: ${result.error}`);
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
