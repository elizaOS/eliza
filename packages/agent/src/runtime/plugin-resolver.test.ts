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
    const stagedDir = stagedDirs[0];
    expect(stagedDir).toBeDefined();
    if (!stagedDir) {
      throw new Error("Expected a staged plugin directory");
    }

    const stagedCronerPath = path.join(
      stagingBaseDir,
      stagedDir,
      "root",
      "node_modules",
      "croner",
    );
    await expect(fs.stat(stagedCronerPath)).resolves.toBeDefined();
  });

  it("merges outer workspace peer dependencies into staged app packages", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-app-plugin-workspace-"),
    );
    try {
      const elizaRoot = path.join(workspaceRoot, "eliza");
      const appRoot = path.join(elizaRoot, "apps", "app-sample");
      await fs.mkdir(path.join(appRoot, "src"), { recursive: true });
      await fs.mkdir(path.join(elizaRoot, "node_modules", "@types", "react"), {
        recursive: true,
      });
      await fs.mkdir(path.join(workspaceRoot, "node_modules", "react"), {
        recursive: true,
      });

      await fs.writeFile(
        path.join(elizaRoot, "node_modules", "@types", "react", "package.json"),
        JSON.stringify({ name: "@types/react", version: "0.0.0" }),
      );
      await fs.writeFile(
        path.join(
          elizaRoot,
          "node_modules",
          "@types",
          "react",
          "jsx-dev-runtime.d.ts",
        ),
        'import "./";\nexport {};\n',
      );
      await fs.writeFile(
        path.join(workspaceRoot, "node_modules", "react", "package.json"),
        JSON.stringify({
          name: "react",
          version: "0.0.0",
          type: "module",
          exports: { "./jsx-dev-runtime": "./jsx-dev-runtime.js" },
        }),
      );
      await fs.writeFile(
        path.join(workspaceRoot, "node_modules", "react", "jsx-dev-runtime.js"),
        [
          'export const Fragment = Symbol.for("react.fragment");',
          "export function jsx() { return null; }",
          "export const jsxs = jsx;",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(appRoot, "package.json"),
        JSON.stringify({
          name: "@elizaos/app-sample",
          version: "0.0.0",
          type: "module",
          main: "./src/index.ts",
          peerDependencies: { react: "*" },
        }),
      );
      await fs.writeFile(
        path.join(appRoot, "src", "index.ts"),
        [
          'import { jsx } from "react/jsx-dev-runtime";',
          "export const appSamplePlugin = {",
          '  name: "app-sample",',
          "  actions: [],",
          "  providers: [],",
          "  evaluators: [],",
          "  services: [],",
          "  routes: [],",
          "};",
          "export const marker = jsx;",
        ].join("\n"),
      );

      const pluginModule = await importPluginModuleFromPath(
        appRoot,
        "@elizaos/app-sample",
      );
      expect(pluginModule.appSamplePlugin).toBeDefined();

      const stagingBaseDir = path.join(
        stateDir,
        "plugins",
        ".runtime-imports",
        "_elizaos_app-sample",
      );
      const stagedDir = (await fs.readdir(stagingBaseDir))[0];
      if (!stagedDir) {
        throw new Error("Expected a staged app package directory");
      }
      await expect(
        fs.stat(
          path.join(stagingBaseDir, stagedDir, "root", "node_modules", "react"),
        ),
      ).resolves.toBeDefined();
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup failures */
      });
    }
  });
});
