/**
 * Unit tests for app-package-modules: the in-process runtime route-module
 * registry, slug aliasing, workspace package discovery (including first-match
 * ordering, legacy `apps/` opt-in, and empty/mismatch cases), and real
 * filesystem imports of local app/plugin entry files. No mocks of the module
 * under test — temp workspaces and real dynamic imports drive every assertion.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AppRouteModule,
  hasRuntimeAppRouteModule,
  importAppPlugin,
  importAppRouteModule,
  packageNameToAppSlug,
  registerRuntimeAppRouteModule,
  resolveWorkspacePackageDir,
  unregisterRuntimeAppRouteModule,
} from "./app-package-modules.ts";

const originalWorkspaceRoot = process.env.ELIZA_WORKSPACE_ROOT;
const originalStateDir = process.env.ELIZA_STATE_DIR;
const originalLegacyApps =
  process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY;
const registeredIds: string[] = [];
const temporaryRoots: string[] = [];

function runtimeModule(marker: string): AppRouteModule {
  return { marker };
}

function trackRegister(id: string, routeModule: AppRouteModule): void {
  registerRuntimeAppRouteModule(id, routeModule);
  registeredIds.push(id);
}

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "apm-cov-"));
  temporaryRoots.push(root);
  process.env.ELIZA_WORKSPACE_ROOT = root;
  process.env.ELIZA_STATE_DIR = path.join(root, "state");
  return root;
}

async function writePackage(
  workspaceRoot: string,
  relativeDir: string,
  packageName: string,
  files: Record<string, string> = {},
  packageJsonExtra: Record<string, unknown> = {},
): Promise<string> {
  const dir = path.join(workspaceRoot, relativeDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: packageName, version: "0.0.0", ...packageJsonExtra }, null, 2)}\n`,
  );
  for (const [rel, contents] of Object.entries(files)) {
    const filePath = path.join(dir, rel);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }
  return dir;
}

afterEach(async () => {
  while (registeredIds.length > 0) {
    const id = registeredIds.pop();
    if (id !== undefined) {
      unregisterRuntimeAppRouteModule(id);
    }
  }
  if (originalWorkspaceRoot === undefined) {
    delete process.env.ELIZA_WORKSPACE_ROOT;
  } else {
    process.env.ELIZA_WORKSPACE_ROOT = originalWorkspaceRoot;
  }
  if (originalStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = originalStateDir;
  }
  if (originalLegacyApps === undefined) {
    delete process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY;
  } else {
    process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY =
      originalLegacyApps;
  }
  const mobile = globalThis as { __ELIZA_MOBILE_BUNDLE__?: boolean };
  delete mobile.__ELIZA_MOBILE_BUNDLE__;
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("packageNameToAppSlug", () => {
  it("strips scoped registry prefixes and app/plugin- basenames", () => {
    expect(packageNameToAppSlug("@elizaos/plugin-wifi")).toBe("wifi");
    expect(packageNameToAppSlug("@elizaos/app-wifi")).toBe("wifi");
    expect(packageNameToAppSlug("plugin-wifi")).toBe("wifi");
    expect(packageNameToAppSlug("@elizaos/agent")).toBe("agent");
  });

  it("returns null for empty or whitespace-only identifiers", () => {
    expect(packageNameToAppSlug("")).toBeNull();
    expect(packageNameToAppSlug("   ")).toBeNull();
  });
});

describe("runtime app route module registry", () => {
  it("treats an empty registry as missing for never-registered identifiers", () => {
    expect(hasRuntimeAppRouteModule("@elizaos/plugin-apm-cov-empty")).toBe(
      false,
    );
    expect(hasRuntimeAppRouteModule("apm-cov-empty")).toBe(false);
  });

  it("registers a single module and returns it from importAppRouteModule", async () => {
    const routeModule = runtimeModule("solo");
    trackRegister("@elizaos/plugin-apm-cov-solo", routeModule);

    expect(hasRuntimeAppRouteModule("@elizaos/plugin-apm-cov-solo")).toBe(true);
    await expect(
      importAppRouteModule("@elizaos/plugin-apm-cov-solo"),
    ).resolves.toBe(routeModule);
  });

  it("aliases scoped plugin/app names onto the same slug key", () => {
    trackRegister("@elizaos/plugin-apm-cov-alias", runtimeModule("alias"));

    expect(hasRuntimeAppRouteModule("@elizaos/plugin-apm-cov-alias")).toBe(
      true,
    );
    expect(hasRuntimeAppRouteModule("@elizaos/app-apm-cov-alias")).toBe(true);
    expect(hasRuntimeAppRouteModule("plugin-apm-cov-alias")).toBe(true);
    expect(hasRuntimeAppRouteModule("apm-cov-alias")).toBe(true);
    expect(hasRuntimeAppRouteModule("@other/plugin-apm-cov-alias")).toBe(true);
  });

  it("does not collide distinct slugs", () => {
    trackRegister("@elizaos/plugin-apm-cov-alpha", runtimeModule("alpha"));
    trackRegister("@elizaos/plugin-apm-cov-beta", runtimeModule("beta"));

    expect(hasRuntimeAppRouteModule("apm-cov-alpha")).toBe(true);
    expect(hasRuntimeAppRouteModule("apm-cov-beta")).toBe(true);
    expect(hasRuntimeAppRouteModule("apm-cov-gamma")).toBe(false);
  });

  it("last register for the same slug wins (overwrite)", async () => {
    trackRegister("apm-cov-tie", runtimeModule("first"));
    const second = runtimeModule("second");
    trackRegister("@elizaos/plugin-apm-cov-tie", second);

    await expect(importAppRouteModule("apm-cov-tie")).resolves.toBe(second);
  });

  it("unregister of a missing item is a no-op", () => {
    expect(() =>
      unregisterRuntimeAppRouteModule("@elizaos/plugin-apm-cov-missing"),
    ).not.toThrow();
    expect(hasRuntimeAppRouteModule("@elizaos/plugin-apm-cov-missing")).toBe(
      false,
    );
  });

  it("unregister by slug removes a module registered under a scoped name", () => {
    trackRegister("@elizaos/plugin-apm-cov-drop", runtimeModule("drop"));
    unregisterRuntimeAppRouteModule("apm-cov-drop");

    expect(hasRuntimeAppRouteModule("@elizaos/plugin-apm-cov-drop")).toBe(
      false,
    );
  });

  it("whitespace identifiers do not slug-collapse onto the empty key", () => {
    trackRegister("   ", runtimeModule("spaces"));

    expect(hasRuntimeAppRouteModule("   ")).toBe(true);
    expect(hasRuntimeAppRouteModule("")).toBe(false);
  });
});

describe("resolveWorkspacePackageDir", () => {
  it("returns null for an empty workspace (no matching package.json)", async () => {
    await makeWorkspace();
    expect(
      await resolveWorkspacePackageDir("@elizaos/plugin-apm-cov-absent"),
    ).toBeNull();
  });

  it("finds a single plugins/ match and returns its resolved directory", async () => {
    const root = await makeWorkspace();
    const dir = await writePackage(
      root,
      "plugins/plugin-apm-cov-one",
      "@elizaos/plugin-apm-cov-one",
    );

    expect(
      await resolveWorkspacePackageDir("@elizaos/plugin-apm-cov-one"),
    ).toBe(path.resolve(dir));
  });

  it("prefers plugins/ over packages/ when both names match (first-match order)", async () => {
    const root = await makeWorkspace();
    const pluginsDir = await writePackage(
      root,
      "plugins/plugin-apm-cov-order",
      "@elizaos/plugin-apm-cov-order",
    );
    await writePackage(
      root,
      "packages/plugin-apm-cov-order",
      "@elizaos/plugin-apm-cov-order",
    );

    expect(
      await resolveWorkspacePackageDir("@elizaos/plugin-apm-cov-order"),
    ).toBe(path.resolve(pluginsDir));
  });

  it("skips a candidate whose package.json name does not match", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-mismatch",
      "@elizaos/plugin-someone-else",
    );

    expect(
      await resolveWorkspacePackageDir("@elizaos/plugin-apm-cov-mismatch"),
    ).toBeNull();
  });

  it("skips invalid JSON and package.json files with a non-string name", async () => {
    const root = await makeWorkspace();
    const invalidDir = path.join(root, "plugins", "plugin-apm-cov-invalid");
    await fs.mkdir(invalidDir, { recursive: true });
    await fs.writeFile(path.join(invalidDir, "package.json"), "<not json>");
    const namelessDir = path.join(root, "plugins", "plugin-apm-cov-nameless");
    await fs.mkdir(namelessDir, { recursive: true });
    await fs.writeFile(
      path.join(namelessDir, "package.json"),
      JSON.stringify({ version: "1.0.0", name: 12 }),
    );

    expect(
      await resolveWorkspacePackageDir("@elizaos/plugin-apm-cov-invalid"),
    ).toBeNull();
    expect(
      await resolveWorkspacePackageDir("@elizaos/plugin-apm-cov-nameless"),
    ).toBeNull();
  });

  it("discovers a nested workspace child plugins/ directory", async () => {
    const root = await makeWorkspace();
    const nested = await writePackage(
      root,
      "worktree/plugins/plugin-apm-cov-nested",
      "@elizaos/plugin-apm-cov-nested",
    );

    expect(
      await resolveWorkspacePackageDir("@elizaos/plugin-apm-cov-nested"),
    ).toBe(path.resolve(nested));
  });

  it("does not scan hidden child directories", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      ".hidden/plugins/plugin-apm-cov-hidden",
      "@elizaos/plugin-apm-cov-hidden",
    );

    expect(
      await resolveWorkspacePackageDir("@elizaos/plugin-apm-cov-hidden"),
    ).toBeNull();
  });

  it("ignores apps/ unless legacy workspace discovery is enabled", async () => {
    const root = await makeWorkspace();
    const appsDir = await writePackage(
      root,
      "apps/plugin-apm-cov-legacy",
      "@elizaos/plugin-apm-cov-legacy",
    );

    expect(
      await resolveWorkspacePackageDir("@elizaos/plugin-apm-cov-legacy"),
    ).toBeNull();

    process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY = "1";
    expect(
      await resolveWorkspacePackageDir("@elizaos/plugin-apm-cov-legacy"),
    ).toBe(path.resolve(appsDir));
  });

  it("trims ELIZA_WORKSPACE_ROOT and treats a whitespace-only value as unset", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-trim",
      "@elizaos/plugin-apm-cov-trim",
    );
    process.env.ELIZA_WORKSPACE_ROOT = `  ${root}  `;

    expect(
      await resolveWorkspacePackageDir("@elizaos/plugin-apm-cov-trim"),
    ).toBe(path.resolve(root, "plugins", "plugin-apm-cov-trim"));

    process.env.ELIZA_WORKSPACE_ROOT = "   ";
    expect(
      await resolveWorkspacePackageDir("@elizaos/plugin-apm-cov-no-such-pkg"),
    ).toBeNull();
  });
});

describe("importAppRouteModule", () => {
  it("returns null for an empty or whitespace identifier with no runtime module", async () => {
    await expect(importAppRouteModule("")).resolves.toBeNull();
    await expect(importAppRouteModule("   ")).resolves.toBeNull();
  });

  it("prefers a runtime-registered module over a workspace-local app.js", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-pref",
      "@elizaos/plugin-apm-cov-pref",
      {
        "src/app.js": "export const marker = 'local';\n",
      },
    );
    const runtime = runtimeModule("runtime");
    trackRegister("@elizaos/plugin-apm-cov-pref", runtime);

    await expect(
      importAppRouteModule("@elizaos/plugin-apm-cov-pref"),
    ).resolves.toBe(runtime);
  });

  it("imports src/app.js from a workspace-local package when no runtime module is registered", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-appjs",
      "@elizaos/plugin-apm-cov-appjs",
      {
        "src/app.js":
          "export const marker = 'from-app-js';\nexport async function handleAppRoutes() { return true; }\n",
      },
    );

    const loaded = await importAppRouteModule("@elizaos/plugin-apm-cov-appjs");
    expect(loaded).toMatchObject({ marker: "from-app-js" });
    await expect(loaded?.handleAppRoutes?.({} as never)).resolves.toBe(true);
  });

  it("falls through to src/routes.js when src/app.js exists but fails to import", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-fallback",
      "@elizaos/plugin-apm-cov-fallback",
      {
        "src/app.js": "export default { this is not valid js\n",
        "src/routes.js": "export const marker = 'from-routes-js';\n",
      },
    );

    await expect(
      importAppRouteModule("@elizaos/plugin-apm-cov-fallback"),
    ).resolves.toMatchObject({ marker: "from-routes-js" });
  });

  it("imports a package.json bridgeExport path that starts with ./", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-bridge",
      "@elizaos/plugin-apm-cov-bridge",
      {
        "custom.js": "export const marker = 'from-bridge';\n",
        "src/app.js": "export const marker = 'from-app-js';\n",
      },
      {
        elizaos: { app: { bridgeExport: "./custom.js" } },
      },
    );

    await expect(
      importAppRouteModule("@elizaos/plugin-apm-cov-bridge"),
    ).resolves.toMatchObject({ marker: "from-bridge" });
  });

  it("ignores a bridgeExport that is not a ./ relative path and uses src/app.js", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-badbridge",
      "@elizaos/plugin-apm-cov-badbridge",
      {
        "src/app.js": "export const marker = 'default-app';\n",
      },
      {
        elizaos: { app: { bridgeExport: "custom.js" } },
      },
    );

    await expect(
      importAppRouteModule("@elizaos/plugin-apm-cov-badbridge"),
    ).resolves.toMatchObject({ marker: "default-app" });
  });

  it("returns null for a workspace package that has no app, routes, or plugin bridge", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-empty-pkg",
      "@elizaos/plugin-apm-cov-empty-pkg",
    );

    await expect(
      importAppRouteModule("@elizaos/plugin-apm-cov-empty-pkg"),
    ).resolves.toBeNull();
  });

  it("skips the packaged self-agent import on a mobile bundle when no local module exists", async () => {
    await makeWorkspace();
    (
      globalThis as { __ELIZA_MOBILE_BUNDLE__?: boolean }
    ).__ELIZA_MOBILE_BUNDLE__ = true;

    await expect(importAppRouteModule("@elizaos/agent")).resolves.toBeNull();
  });
});

describe("importAppPlugin", () => {
  it("returns null for the self-agent package on a mobile bundle", async () => {
    (
      globalThis as { __ELIZA_MOBILE_BUNDLE__?: boolean }
    ).__ELIZA_MOBILE_BUNDLE__ = true;
    await expect(importAppPlugin("@elizaos/agent")).resolves.toBeNull();
  });

  it("loads a React-free src/plugin.js default export whose name is a string", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-plug",
      "@elizaos/plugin-apm-cov-plug",
      {
        "src/plugin.js":
          "export default { name: '@elizaos/plugin-apm-cov-plug', description: 'cov' };\n",
      },
    );

    await expect(
      importAppPlugin("@elizaos/plugin-apm-cov-plug"),
    ).resolves.toEqual({
      name: "@elizaos/plugin-apm-cov-plug",
      description: "cov",
    });
  });

  it("selects a named export whose name matches the package when default is not plugin-like", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-named",
      "@elizaos/plugin-apm-cov-named",
      {
        "src/plugin.js":
          "export default { notAPlugin: true };\nexport const plugin = { name: '@elizaos/plugin-apm-cov-named' };\nexport const other = { name: 'someone-else' };\n",
      },
    );

    await expect(
      importAppPlugin("@elizaos/plugin-apm-cov-named"),
    ).resolves.toEqual({ name: "@elizaos/plugin-apm-cov-named" });
  });

  it("falls back to src/index.js when src/plugin.js is absent", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-index",
      "@elizaos/plugin-apm-cov-index",
      {
        "src/index.js":
          "export default { name: '@elizaos/plugin-apm-cov-index' };\n",
      },
    );

    await expect(
      importAppPlugin("@elizaos/plugin-apm-cov-index"),
    ).resolves.toEqual({ name: "@elizaos/plugin-apm-cov-index" });
  });

  it("returns null when the loaded module has no plugin-like export", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-noplug",
      "@elizaos/plugin-apm-cov-noplug",
      {
        "src/plugin.js": "export const answer = 42;\n",
      },
    );

    await expect(
      importAppPlugin("@elizaos/plugin-apm-cov-noplug"),
    ).resolves.toBeNull();
  });

  it("loads a dynamically-installed plugin after workspace candidates lack a plugin export", async () => {
    const root = await makeWorkspace();
    await writePackage(
      root,
      "plugins/plugin-apm-cov-installed",
      "@elizaos/plugin-apm-cov-installed",
    );
    const installedDir = path.join(
      root,
      "state",
      "plugins",
      "installed",
      "_elizaos_plugin-apm-cov-installed",
      "node_modules",
      "@elizaos",
      "plugin-apm-cov-installed",
    );
    await fs.mkdir(path.join(installedDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(installedDir, "package.json"),
      `${JSON.stringify({ name: "@elizaos/plugin-apm-cov-installed", version: "0.0.0" })}\n`,
    );
    await fs.writeFile(
      path.join(installedDir, "src", "plugin.js"),
      "export default { name: '@elizaos/plugin-apm-cov-installed', source: 'installed' };\n",
    );

    await expect(
      importAppPlugin("@elizaos/plugin-apm-cov-installed"),
    ).resolves.toEqual({
      name: "@elizaos/plugin-apm-cov-installed",
      source: "installed",
    });
  });
});
