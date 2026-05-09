import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLocalInferenceLoadArgs } from "./active-model";
import type { InstalledModel } from "./types";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function makeInstalledModel(id: string, filePath: string): InstalledModel {
  return {
    id,
    displayName: id,
    path: filePath,
    sizeBytes: 1024,
    installedAt: "2026-05-08T00:00:00.000Z",
    lastUsedAt: null,
    source: "eliza-download",
  };
}

function writeRegistry(root: string, models: InstalledModel[]): void {
  const localRoot = path.join(root, "local-inference");
  fs.mkdirSync(localRoot, { recursive: true });
  fs.writeFileSync(
    path.join(localRoot, "registry.json"),
    JSON.stringify({ version: 1, models }, null, 2),
    "utf8",
  );
}

describe("resolveLocalInferenceLoadArgs", () => {
  it("carries DFlash companion and speculative settings into loader args", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-load-args-"));
    process.env.ELIZA_STATE_DIR = root;
    const target = makeInstalledModel(
      "qwen3.5-4b-dflash",
      path.join(root, "local-inference", "models", "qwen.gguf"),
    );
    const drafter = makeInstalledModel(
      "qwen3.5-4b-dflash-drafter-q4",
      path.join(root, "local-inference", "models", "qwen-drafter.gguf"),
    );
    writeRegistry(root, [target, drafter]);

    const args = await resolveLocalInferenceLoadArgs(target);

    expect(args).toMatchObject({
      modelPath: target.path,
      draftModelPath: drafter.path,
      contextSize: 8192,
      draftContextSize: 256,
      draftMin: 1,
      draftMax: 16,
      speculativeSamples: 16,
      mobileSpeculative: true,
      disableThinking: true,
      useGpu: true,
    });
  });

  it("carries TurboQuant KV cache metadata into loader args", async () => {
    const target = makeInstalledModel("bonsai-8b-1bit", "/tmp/Bonsai-8B.gguf");

    const args = await resolveLocalInferenceLoadArgs(target);

    expect(args.cacheTypeK).toBe("tbq4_0");
    expect(args.cacheTypeV).toBe("tbq3_0");
  });
});
