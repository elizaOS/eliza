import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyLocalWorkspaceApps } from "./registry-client-local";
import type { RegistryPluginInfo } from "./registry-client-types";

describe("applyLocalWorkspaceApps", () => {
  let workspaceRoot: string;
  let originalWorkspaceRoot: string | undefined;
  let originalLegacyAppsDiscovery: string | undefined;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-registry-local-"),
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

  async function writePackage(params: {
    dir: string;
    displayName: string;
    packageName: string;
  }): Promise<void> {
    await fs.mkdir(params.dir, { recursive: true });
    await fs.writeFile(
      path.join(params.dir, "package.json"),
      JSON.stringify({
        name: params.packageName,
        version: "0.0.0",
        description: params.displayName,
        elizaos: {
          kind: "app",
          app: {
            displayName: params.displayName,
            launchType: "connect",
          },
        },
      }),
    );
  }

  it("discovers app plugins from plugins/app-*", async () => {
    const packageName = "@elizaos/app-lifeops";
    const appPluginDir = path.join(workspaceRoot, "plugins", "app-lifeops");
    await writePackage({
      dir: appPluginDir,
      displayName: "LifeOps App Plugin",
      packageName,
    });

    const registry = new Map<string, RegistryPluginInfo>();
    await applyLocalWorkspaceApps(registry);

    expect(registry.get(packageName)?.localPath).toBe(appPluginDir);
    expect(registry.get(packageName)?.appMeta?.displayName).toBe(
      "LifeOps App Plugin",
    );
  });

  it("keeps plugins/app-* first when legacy apps/* discovery is enabled", async () => {
    const packageName = "@elizaos/app-lifeops";
    const appPluginDir = path.join(workspaceRoot, "plugins", "app-lifeops");
    const legacyAppDir = path.join(workspaceRoot, "apps", "app-lifeops");
    await writePackage({
      dir: appPluginDir,
      displayName: "Plugin LifeOps",
      packageName,
    });
    await writePackage({
      dir: legacyAppDir,
      displayName: "Legacy LifeOps",
      packageName,
    });
    process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY = "1";

    const registry = new Map<string, RegistryPluginInfo>();
    await applyLocalWorkspaceApps(registry);

    expect(registry.get(packageName)?.localPath).toBe(appPluginDir);
    expect(registry.get(packageName)?.appMeta?.displayName).toBe(
      "Plugin LifeOps",
    );
  });
});
