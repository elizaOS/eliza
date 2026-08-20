/**
 * Pins `discoverSideEffectAppModules` against the real plugin/package tree:
 * every plugin that self-declares `elizaos.appRegister` must be discovered in
 * a stable order under a role-qualified loader identity (`<name>#<mode>`),
 * resolve a real entry file, and be a `workspace:*` dependency of this app —
 * and the first-render `/register` module must still be imported by main.tsx.
 * Also proves the production Vite transform injects the discovered loaders and
 * that no generated identity can collide with a package-root facade key in the
 * shared dynamic-import cache (#16504). Reads the live filesystem (no mocks).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appSideEffectModulesPlugin,
  discoverSideEffectAppModules,
} from "../vite/app-side-effect-modules.ts";
import { cachedDynamicImport } from "./app-module-cache.ts";

// The renderer side-effect app-module list is no longer hardcoded in the app
// shell — each app plugin self-declares `elizaos.appRegister` in its own
// package.json and the renderer build scans for it. This test pins the scan's
// result against the real plugin tree so a regression (a dropped marker, a moved
// entry file, a plugin added without a workspace dep) fails loudly.

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SCAN_ROOTS = [
  resolve(REPO_ROOT, "plugins"),
  resolve(REPO_ROOT, "packages"),
];

// Role-qualified loader identities expected to self-declare renderer
// registration: `<canonical package name>#<appRegister mode>`.
const EXPECTED_SIDE_EFFECT_MODULES = [
  "@elizaos/plugin-calendar#register",
  "@elizaos/plugin-contacts#register",
  "@elizaos/plugin-maps#register",
  "@elizaos/plugin-native-settings#register",
  "@elizaos/plugin-notes#register",
  "@elizaos/plugin-personal-assistant#register",
  "@elizaos/plugin-phone#register",
  "@elizaos/plugin-trajectory-logger#register",
  "@elizaos/plugin-wallet#register",
  "@elizaos/plugin-wifi#register",
] as const;

// Imported directly by the app shell (main.tsx), not via the manifest scan.
const FIRST_RENDER_REGISTRATION_MODULES = [
  "@elizaos/plugin-task-coordinator/register",
] as const;

describe("side-effect app module registration (manifest-driven)", () => {
  it("discovers every plugin that self-declares elizaos.appRegister", () => {
    const discovered = discoverSideEffectAppModules(SCAN_ROOTS);
    expect(discovered.map((m) => m.key)).toEqual([
      ...EXPECTED_SIDE_EFFECT_MODULES,
    ]);
  });

  it("role-qualifies every loader identity as <packageName>#<mode>", () => {
    for (const module of discoverSideEffectAppModules(SCAN_ROOTS)) {
      expect(module.key).toBe(`${module.packageName}#${module.mode}`);
      expect(module.key).not.toBe(module.packageName);
    }
  });

  it("discovers Personal Assistant in register mode with the register entry", () => {
    const pa = discoverSideEffectAppModules(SCAN_ROOTS).find(
      (m) => m.packageName === "@elizaos/plugin-personal-assistant",
    );
    expect(pa).toBeDefined();
    expect(pa?.mode).toBe("register");
    expect(pa?.key).toBe("@elizaos/plugin-personal-assistant#register");
    expect(pa?.entry).toBe(
      resolve(REPO_ROOT, "plugins/plugin-personal-assistant/src/register.ts"),
    );
  });

  it("resolves a real entry file for every discovered module", () => {
    for (const module of discoverSideEffectAppModules(SCAN_ROOTS)) {
      expect(() => readFileSync(module.entry, "utf8")).not.toThrow();
    }
  });

  it("declares each discovered module as a workspace dependency", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    for (const module of discoverSideEffectAppModules(SCAN_ROOTS)) {
      expect(packageJson.dependencies?.[module.packageName]).toBe(
        "workspace:*",
      );
    }
  });

  it("loads chat inline-widget registrations before first render", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "main.tsx"),
      "utf8",
    );

    for (const moduleId of FIRST_RENDER_REGISTRATION_MODULES) {
      expect(source).toContain(`import("${moduleId}")`);
    }
  });
});

describe("production loader identity (vite transform + import cache)", () => {
  function transformedRegistrations(): string {
    const sourcePath = resolve(import.meta.dirname, "plugin-registrations.ts");
    const source = readFileSync(sourcePath, "utf8");
    const plugin = appSideEffectModulesPlugin(SCAN_ROOTS);
    const result = plugin.transform(source, sourcePath) as {
      code: string;
    } | null;
    expect(result).not.toBeNull();
    return (result as { code: string }).code;
  }

  it("injects Personal Assistant's register entry under its role-qualified key", () => {
    const code = transformedRegistrations();
    expect(code).toContain('"@elizaos/plugin-personal-assistant#register"');
    expect(code).toContain("plugins/plugin-personal-assistant/src/register.ts");
    // The transform must import the register entry, never the root facade.
    expect(code).not.toContain("plugins/plugin-personal-assistant/src/ui.ts");
    expect(code).not.toContain(
      "plugins/plugin-personal-assistant/src/index.ts",
    );
  });

  it("never generates a loader key that collides with a package-root cache key in main.tsx", () => {
    const mainSource = readFileSync(
      resolve(import.meta.dirname, "main.tsx"),
      "utf8",
    );
    // Every cache identity main.tsx uses directly (manual loader lists and
    // direct cachedDynamicImport calls).
    const manualKeys = new Set(
      [
        ...mainSource.matchAll(/(?:key:|cachedDynamicImport\()\s*"([^"]+)"/g),
      ].map((m) => m[1]),
    );
    expect(manualKeys).toContain("@elizaos/plugin-personal-assistant");

    const generatedKeys = discoverSideEffectAppModules(SCAN_ROOTS).map(
      (m) => m.key,
    );
    expect(new Set(generatedKeys).size).toBe(generatedKeys.length);
    for (const key of generatedKeys) {
      expect(manualKeys.has(key)).toBe(false);
    }
  });

  it("loads a root facade and register entry together: distinct promises, one evaluation each", async () => {
    // Two namespaces from the same package, requested through the shared
    // import cache under role-qualified identities — mirrors the production
    // boot where the idle schedule and on-demand consumers both request them.
    const facadeNamespace = { role: "root-facade" };
    const registerNamespace = { role: "register-entry" };
    const loadFacade = vi.fn(async () => facadeNamespace);
    const loadRegister = vi.fn(async () => registerNamespace);

    const facadeKey = "@elizaos/test-plugin";
    const registerKey = "@elizaos/test-plugin#register";

    const results = await Promise.all([
      cachedDynamicImport(facadeKey, loadFacade),
      cachedDynamicImport(registerKey, loadRegister),
      // Repeat requests for both identities (idle schedule + consumer).
      cachedDynamicImport(facadeKey, loadFacade),
      cachedDynamicImport(registerKey, loadRegister),
    ]);

    // Each loader ran exactly once …
    expect(loadFacade).toHaveBeenCalledTimes(1);
    expect(loadRegister).toHaveBeenCalledTimes(1);
    // … and every consumer received the namespace matching its identity —
    // the register entry can never suppress or impersonate the root facade.
    expect(results[0]).toBe(facadeNamespace);
    expect(results[1]).toBe(registerNamespace);
    expect(results[2]).toBe(facadeNamespace);
    expect(results[3]).toBe(registerNamespace);
  });
});
