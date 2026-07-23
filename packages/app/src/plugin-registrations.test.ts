/**
 * Pins `discoverSideEffectAppModules` against the real plugin/package tree:
 * every plugin that self-declares `elizaos.appRegister` must be discovered in a
 * stable order, resolve a real entry file, carry a role-qualified cache
 * identity distinct from its package root, and be a `workspace:*` dependency of
 * this app — and the first-render `/register` module must still be imported by
 * main.tsx. Reads the live filesystem (no mocks).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appSideEffectModulesPlugin,
  discoverSideEffectAppModules,
} from "../vite/app-side-effect-modules.ts";

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

// Role-qualified module identities expected from the scan. The `#<mode>`
// suffix is load-bearing: the app shell caches dynamic imports by key, and the
// same cache also holds package ROOT facades keyed by bare package name
// (main.tsx BOOT_CONFIG_DEFERRED_MODULE_LOADERS). A bare-name key here would
// let whichever loader ran first suppress the other (#16504) — e.g.
// plugin-phone's root facade import silently dropping its register entry.
const EXPECTED_SIDE_EFFECT_MODULE_KEYS = [
  "@elizaos/app-model-tester#ui",
  "@elizaos/plugin-contacts#register",
  "@elizaos/plugin-facewear#register",
  "@elizaos/plugin-feed#register",
  "@elizaos/plugin-hyperliquid#register",
  "@elizaos/plugin-native-settings#register",
  "@elizaos/plugin-personal-assistant#register",
  "@elizaos/plugin-phone#register",
  "@elizaos/plugin-polymarket#register",
  "@elizaos/plugin-simple-views#register",
  "@elizaos/plugin-trajectory-logger#register",
  "@elizaos/plugin-vector-browser#register",
  "@elizaos/plugin-wallet-ui#register",
  "@elizaos/plugin-wifi#register",
] as const;

// Package roots the app shell ALSO loads through the same dynamic-import cache
// (cachedDynamicImport in main.tsx). Discovered side-effect keys must never
// collide with these bare-name identities.
const MAIN_TSX_CACHE_KEY_PATTERN = /cachedDynamicImport\(\s*\n?\s*"([^"]+)"/g;

// Imported directly by the app shell (main.tsx), not via the manifest scan.
const FIRST_RENDER_REGISTRATION_MODULES = [
  "@elizaos/plugin-task-coordinator/register",
] as const;

describe("side-effect app module registration (manifest-driven)", () => {
  it("discovers every plugin that self-declares elizaos.appRegister with a role-qualified key", () => {
    const discovered = discoverSideEffectAppModules(SCAN_ROOTS);
    expect(discovered.map((m) => m.key)).toEqual([
      ...EXPECTED_SIDE_EFFECT_MODULE_KEYS,
    ]);
    for (const module of discovered) {
      expect(module.key).toBe(`${module.packageName}#${module.mode}`);
    }
  });

  it("never reuses a bare package name as a side-effect cache identity", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "main.tsx"),
      "utf8",
    );
    const shellCacheKeys = new Set(
      [...source.matchAll(MAIN_TSX_CACHE_KEY_PATTERN)].map(
        (match) => match[1] ?? "",
      ),
    );
    expect(shellCacheKeys.size).toBeGreaterThan(0);
    for (const module of discoverSideEffectAppModules(SCAN_ROOTS)) {
      // The role-qualified key must be distinct from the package-root cache
      // identity even when the shell also imports that package's root facade.
      expect(module.key).not.toBe(module.packageName);
      expect(shellCacheKeys.has(module.key)).toBe(false);
    }
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

  it("rewrites the loader marker with role-qualified keys importing the intended entries", () => {
    // Run the real production transform against the real plugin-registrations
    // source: the generated loader list must key every module by its
    // role-qualified identity and import the exact discovered entry file —
    // e.g. Personal Assistant's `src/register.ts`, never its root facade.
    const plugin = appSideEffectModulesPlugin(SCAN_ROOTS);
    const source = readFileSync(
      resolve(import.meta.dirname, "plugin-registrations.ts"),
      "utf8",
    );
    const result = plugin.transform(
      source,
      "/repo/packages/app/src/plugin-registrations.ts",
    );
    expect(result).not.toBeNull();
    const code = (result as { code: string }).code;

    for (const module of discoverSideEffectAppModules(SCAN_ROOTS)) {
      expect(code).toContain(
        `{ key: ${JSON.stringify(module.key)}, load: () => import(${JSON.stringify(module.entry)}) },`,
      );
    }
    const paRegisterEntry = resolve(
      REPO_ROOT,
      "plugins/plugin-personal-assistant/src/register.ts",
    );
    expect(code).toContain(JSON.stringify(paRegisterEntry));
    expect(code).not.toContain('key: "@elizaos/plugin-personal-assistant",');
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
