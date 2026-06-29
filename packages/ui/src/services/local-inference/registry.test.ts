import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listInstalledModels,
  removeElizaModel,
  upsertElizaModel,
} from "./registry";
import type { InstalledModel } from "./types";

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function useTempStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-ui-registry-"));
  tempDirs.push(stateDir);
  process.env.ELIZA_STATE_DIR = stateDir;
  return stateDir;
}

function installedModel(
  id: string,
  modelPath: string,
  overrides: Partial<InstalledModel> = {},
): InstalledModel {
  return {
    id,
    displayName: id,
    path: modelPath,
    sizeBytes: 1024,
    installedAt: "2026-06-28T00:00:00.000Z",
    lastUsedAt: null,
    source: "eliza-download",
    ...overrides,
  };
}

describe("local inference registry removal", () => {
  it("removes an Eliza-owned bundle directory and clears the registry entry", async () => {
    const stateDir = useTempStateDir();
    const bundleRoot = path.join(
      stateDir,
      "local-inference",
      "models",
      "eliza-1-2b",
    );
    const modelPath = path.join(bundleRoot, "text", "model.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "fake-model");

    await upsertElizaModel(
      installedModel("eliza-1-2b", modelPath, { bundleRoot }),
    );

    await expect(removeElizaModel("eliza-1-2b")).resolves.toEqual({
      removed: true,
    });
    expect(fs.existsSync(bundleRoot)).toBe(false);
    expect(await listInstalledModels()).toEqual([]);
  });

  it("clears stale registry entries when the model path is already missing", async () => {
    const stateDir = useTempStateDir();
    const modelPath = path.join(
      stateDir,
      "local-inference",
      "models",
      "missing.gguf",
    );

    await upsertElizaModel(installedModel("missing-model", modelPath));

    await expect(removeElizaModel("missing-model")).resolves.toEqual({
      removed: true,
    });
    expect(await listInstalledModels()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a registry path that escapes through a symlinked parent",
    async () => {
      const stateDir = useTempStateDir();
      const outsideDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "eliza-outside-"),
      );
      tempDirs.push(outsideDir);
      const modelsDir = path.join(stateDir, "local-inference", "models");
      const linkPath = path.join(modelsDir, "linked-outside");
      fs.mkdirSync(modelsDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, "model.gguf"), "outside-model");
      fs.symlinkSync(outsideDir, linkPath, "dir");

      const modelPath = path.join(linkPath, "model.gguf");
      await upsertElizaModel(
        installedModel("escaped-model", modelPath, { bundleRoot: linkPath }),
      );

      await expect(removeElizaModel("escaped-model")).resolves.toEqual({
        removed: false,
        reason: "external",
      });
      expect(fs.existsSync(path.join(outsideDir, "model.gguf"))).toBe(true);
      expect((await listInstalledModels()).map((model) => model.id)).toEqual([
        "escaped-model",
      ]);
    },
  );
});
