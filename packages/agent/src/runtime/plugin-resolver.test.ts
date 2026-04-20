import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importPluginModuleFromPath } from "./plugin-resolver";

describe("importPluginModuleFromPath", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;
  let originalWorkspaceRoot: string | undefined;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-plugin-resolver-"),
    );
    originalStateDir = process.env.ELIZA_STATE_DIR;
    originalWorkspaceRoot = process.env.ELIZA_WORKSPACE_ROOT;
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_WORKSPACE_ROOT = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "..",
    );
  });

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = originalStateDir;
    }

    if (originalWorkspaceRoot === undefined) {
      delete process.env.ELIZA_WORKSPACE_ROOT;
    } else {
      process.env.ELIZA_WORKSPACE_ROOT = originalWorkspaceRoot;
    }

    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it("stages declared workspace-plugin dependencies before import", async () => {
    const pluginRoot = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "plugins",
      "plugin-cron",
      "typescript",
    );

    const pluginModule = await importPluginModuleFromPath(
      pluginRoot,
      "@elizaos/plugin-cron",
    );
    expect(pluginModule.cronPlugin).toBeDefined();

    const stagingBaseDir = path.join(
      stateDir,
      "plugins",
      ".runtime-imports",
      "_elizaos_plugin-cron",
    );
    const stagedDirs = await fs.readdir(stagingBaseDir);
    expect(stagedDirs.length).toBeGreaterThan(0);

    const stagedCronerPath = path.join(
      stagingBaseDir,
      stagedDirs[0]!,
      "root",
      "node_modules",
      "croner",
    );
    await expect(fs.stat(stagedCronerPath)).resolves.toBeDefined();
  });
});
