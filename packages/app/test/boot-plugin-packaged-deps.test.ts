/**
 * Asserts every @elizaos/* module the app shell dynamically imports at boot —
 * the cachedDynamicImport/importSideEffectAppModule call sites in src/main.tsx
 * plus the manifest-discovered side-effect registration modules — is declared
 * as a `workspace:*` dependency in packages/app/package.json. A boot loader
 * whose package is not declared resolves in the monorepo dev tree but breaks
 * the packaged renderer build, so the drift must fail here, not at ship time.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverSideEffectAppModules } from "../vite/app-side-effect-modules";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const APP_MAIN_SOURCE = path.resolve(HERE, "../src/main.tsx");

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function appMainPluginIds(): string[] {
  const source = readFileSync(APP_MAIN_SOURCE, "utf8");
  return sorted(
    [
      ...source.matchAll(/cachedDynamicImport\(\s*"([^"]+)"/g),
      ...source.matchAll(/importSideEffectAppModule\(\s*"([^"]+)"/g),
    ].map((match) => match[1] ?? ""),
  );
}

function sideEffectPluginIds(): string[] {
  // Manifest-driven: the side-effect loader list is generated at build time
  // from each plugin's `elizaos.appRegister` marker, so this reads the same
  // scan the renderer build uses, keyed by canonical package name.
  return sorted(
    discoverSideEffectAppModules([
      path.resolve(REPO_ROOT, "plugins"),
      path.resolve(REPO_ROOT, "packages"),
    ]).map((module) => module.key),
  );
}

function appPackageDependencies(): Record<string, string> {
  const packageJson = JSON.parse(
    readFileSync(path.resolve(REPO_ROOT, "packages/app/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  return packageJson.dependencies ?? {};
}

function packageNameForBootModule(moduleId: string): string {
  const scopedPackage = moduleId.match(/^(@[^/]+\/[^/]+)/);
  if (scopedPackage) return scopedPackage[1] ?? moduleId;
  return moduleId.replace(/\/register$/, "");
}

describe("app boot-plugin packaged dependencies", () => {
  it("declares every boot-loaded app plugin module as a workspace dependency", () => {
    const dependencies = appPackageDependencies();
    const bootPluginIds = sorted([
      ...appMainPluginIds(),
      ...sideEffectPluginIds(),
    ]);
    expect(bootPluginIds.length).toBeGreaterThan(0);
    const missingDependencies = bootPluginIds
      .map(packageNameForBootModule)
      .filter((packageName) => packageName.startsWith("@elizaos/"))
      .filter((packageName) => dependencies[packageName] !== "workspace:*");

    expect(
      missingDependencies,
      `Boot-loaded app plugin modules must be declared in packages/app/package.json dependencies: ${missingDependencies.join(", ")}`,
    ).toEqual([]);
  });
});
