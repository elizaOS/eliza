import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  importAppRouteModule,
  resolveWorkspacePackageDir,
} from "./app-package-modules";

describe("app-package-modules workspace discovery", () => {
  let workspaceRoot: string;
  let originalWorkspaceRoot: string | undefined;
  let originalLegacyAppsDiscovery: string | undefined;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-app-package-modules-"),
    );
    originalWorkspaceRoot = process.env.ELIZA_WORKSPACE_ROOT;
    originalLegacyAppsDiscovery =
      process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY;
    process.env.ELIZA_WORKSPACE_ROOT = workspaceRoot;
    delete process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY;
  });

  afterEach(async () => {
    if (originalWorkspaceRoot === undefined) {
      delete process.env.ELIZA_WORKSPACE_ROOT;
    } else {
      process.env.ELIZA_WORKSPACE_ROOT = originalWorkspaceRoot;
    }
    if (originalLegacyAppsDiscovery === undefined) {
      delete process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY;
    } else {
      process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY =
        originalLegacyAppsDiscovery;
    }
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  async function writeAppPluginPackage(params: {
    dir: string;
    marker: string;
    packageName: string;
  }): Promise<void> {
    await fs.mkdir(path.join(params.dir, "src", "routes"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(params.dir, "package.json"),
      JSON.stringify({
        name: params.packageName,
        version: "0.0.0",
        type: "module",
        elizaos: {
          kind: "app",
          app: {
            bridgeExport: "./routes/plugin",
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(params.dir, "src", "routes", "plugin.js"),
      [
        `export const marker = ${JSON.stringify(params.marker)};`,
        "export async function handleAppRoutes() { return true; }",
      ].join("\n"),
    );
  }

  it("prefers plugins/app-* while preserving @elizaos/app-* package names", async () => {
    const packageName = "@elizaos/app-shopify";
    const appPluginDir = path.join(workspaceRoot, "plugins", "app-shopify");
    const legacyAppDir = path.join(workspaceRoot, "apps", "app-shopify");
    await writeAppPluginPackage({
      dir: appPluginDir,
      marker: "plugins-app-shopify",
      packageName,
    });
    await writeAppPluginPackage({
      dir: legacyAppDir,
      marker: "legacy-apps-shopify",
      packageName,
    });

    await expect(resolveWorkspacePackageDir(packageName)).resolves.toBe(
      appPluginDir,
    );

    const routeModule = await importAppRouteModule(packageName);
    expect(routeModule?.marker).toBe("plugins-app-shopify");
  });

  it("only scans legacy apps/* workspaces when explicitly enabled", async () => {
    const packageName = "@elizaos/app-lifeops";
    const legacyAppDir = path.join(workspaceRoot, "apps", "app-lifeops");
    await writeAppPluginPackage({
      dir: legacyAppDir,
      marker: "legacy-apps-lifeops",
      packageName,
    });

    await expect(resolveWorkspacePackageDir(packageName)).resolves.toBeNull();

    process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY = "1";
    await expect(resolveWorkspacePackageDir(packageName)).resolves.toBe(
      legacyAppDir,
    );
  });
});
