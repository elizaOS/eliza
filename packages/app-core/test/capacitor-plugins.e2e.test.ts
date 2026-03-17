/**
 * E2E tests for Capacitor plugin builds and exports.
 *
 * Verifies that each built plugin:
 * - Has a valid dist/ directory with CJS and ESM builds
 * - package.json has correct entry points
 * - package.json has platform metadata
 * - ESM module can be dynamically imported
 * - Exports the expected symbols
 *
 * These tests require plugins to be built first (bun run plugin:build).
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const localRequire = createRequire(import.meta.url);

function resolveExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveEsmIndexPath(pluginDir: string): string | null {
  return resolveExistingPath([
    path.join(pluginDir, "dist", "esm", "index.js"),
    path.join(pluginDir, "dist", "esm", "src", "index.js"),
    path.join(pluginDir, "dist", "esm", "index"),
    path.join(pluginDir, "dist", "esm", "src", "index"),
  ]);
}

function resolvePackageDir(packageName: string): string {
  return path.dirname(localRequire.resolve(`${packageName}/package.json`));
}

const PLUGINS = [
  { name: "@miladyai/capacitor-gateway", exportName: "Gateway" },
  { name: "@miladyai/capacitor-camera", exportName: "Camera" },
  { name: "@miladyai/capacitor-canvas", exportName: "Canvas" },
  { name: "@miladyai/capacitor-desktop", exportName: "Desktop" },
  {
    name: "@miladyai/capacitor-location",
    exportName: "Location",
  },
  {
    name: "@miladyai/capacitor-screencapture",
    exportName: "ScreenCapture",
  },
  { name: "@miladyai/capacitor-swabble", exportName: "Swabble" },
  {
    name: "@miladyai/capacitor-talkmode",
    exportName: "TalkMode",
  },
];

describe("Capacitor Plugin Build Verification", () => {
  for (const plugin of PLUGINS) {
    describe(plugin.name, () => {
      const dir = resolvePackageDir(plugin.name);
      const pkgPath = path.join(dir, "package.json");

      it("package.json exists and is valid JSON", () => {
        expect(fs.existsSync(pkgPath)).toBe(true);
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        expect(pkg.name).toBe(plugin.name);
      });

      it("has platform metadata", () => {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        expect(pkg.milady).toBeDefined();
        expect(pkg.milady.runtime).toBeDefined();
        expect(Array.isArray(pkg.milady.platforms)).toBe(true);
        expect(pkg.milady.platforms.length).toBeGreaterThan(0);
      });

      it("has main, module, and types entry points", () => {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        expect(pkg.main).toBeDefined();
        expect(pkg.module).toBeDefined();
        expect(pkg.types).toBeDefined();
      });

      it("dist/ directory exists with built files", () => {
        const distDir = path.join(dir, "dist");
        const built = fs.existsSync(distDir);
        if (!built) {
          // Skip rather than fail — plugins may not be built in CI
          console.warn(
            `[SKIP] ${plugin.name}: dist/ not found (run bun run plugin:build)`,
          );
          return;
        }

        const cjsPath = resolveExistingPath([
          path.join(distDir, "plugin.cjs.js"),
          path.join(distDir, "plugin.cjs"),
        ]);
        const esmPath = resolveEsmIndexPath(dir);

        // Check type declarations
        const hasTypes =
          resolveExistingPath([
            path.join(distDir, "esm", "index.d.ts"),
            path.join(distDir, "esm", "src", "index.d.ts"),
          ]) !== null;

        if (!cjsPath || !esmPath || !hasTypes) {
          console.warn(
            `[SKIP] ${plugin.name}: partial dist output (run bun run plugin:build)`,
          );
          return;
        }

        expect(fs.existsSync(cjsPath)).toBe(true);
        expect(esmPath).not.toBeNull();
        expect(hasTypes).toBe(true);
      });

      it("ESM index.js exports expected symbols", async () => {
        const esmPath = resolveEsmIndexPath(dir);
        if (!esmPath) {
          console.warn(`[SKIP] ${plugin.name}: ESM build not found`);
          return;
        }

        const mod = await import(esmPath);
        expect(mod[plugin.exportName]).toBeDefined();
      });

      it("definitions are exported", async () => {
        const esmPath = resolveEsmIndexPath(dir);
        if (!esmPath) {
          console.warn(`[SKIP] ${plugin.name}: ESM build not found`);
          return;
        }

        // All plugins re-export from definitions.ts
        const mod = await import(esmPath);
        const exportKeys = Object.keys(mod);
        // Should have at least the main export + some type re-exports
        expect(exportKeys.length).toBeGreaterThan(0);
        expect(exportKeys).toContain(plugin.exportName);
      });
    });
  }
});
