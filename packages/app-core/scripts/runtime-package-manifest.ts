import fs from "node:fs";
import path from "node:path";
// Import from the specific subpath instead of "@elizaos/agent" so loading
// this module during release/build scripts doesn't transitively pull in
// eliza/packages/agent/src/runtime/eliza.ts (which has top-level imports
// of @elizaos/plugin-* runtime providers). copy-runtime-node-modules runs
// in release pipelines where those plugin packages are not yet installed
// in node_modules, so the broader import path crashes with
// ERR_MODULE_NOT_FOUND for @elizaos/plugin-anthropic / -sql / etc.
import {
  BASELINE_BUNDLED_RUNTIME_PACKAGES,
  getBundledRuntimePackages,
} from "@elizaos/agent/runtime/release-plugin-policy";

const JS_FILE_RE = /\.(?:[cm]?js)$/i;
const IMPORT_SPECIFIER_RE =
  /\b(?:import|export)\s+(?:[^"'`;]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

export function normalizePackageName(specifier: string): string | null {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("file:")
  ) {
    return null;
  }

  if (specifier.startsWith("@")) {
    const [scope, pkg] = specifier.split("/");
    return scope && pkg ? `${scope}/${pkg}` : null;
  }

  const [pkg] = specifier.split("/");
  return pkg || null;
}

export function extractBarePackageSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const matches = source.matchAll(IMPORT_SPECIFIER_RE);

  for (const match of matches) {
    const raw = match[1] || match[2] || match[3];
    const normalized = raw ? normalizePackageName(raw) : null;
    if (normalized) found.add(normalized);
  }

  return [...found].sort();
}

export function isRuntimePluginPackage(packageName: string): boolean {
  if (!packageName) return false;
  if (packageName.startsWith("plugin-")) return true;
  if (!packageName.startsWith("@")) return false;

  const [, scopedName] = packageName.split("/");
  return scopedName?.startsWith("plugin-") ?? false;
}

export function shouldBundleDiscoveredPackage(
  packageName: string,
  alwaysBundled: ReadonlySet<string>,
): boolean {
  if (packageName === "@elizaos/plugin-n8n-workflow") {
    return true;
  }

  if (!isRuntimePluginPackage(packageName)) {
    return true;
  }

  return alwaysBundled.has(packageName);
}

export function discoverRuntimePackages(scanDir: string): string[] {
  const found = new Set<string>();

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!entry.isFile() || !JS_FILE_RE.test(entry.name)) continue;
      const source = fs.readFileSync(entryPath, "utf8");
      for (const pkg of extractBarePackageSpecifiers(source)) {
        found.add(pkg);
      }
    }
  }

  walk(scanDir);
  return [...found].sort();
}

export function discoverAlwaysBundledPackages(
  packageJsonPath: string,
): string[] {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return getBundledRuntimePackages(Object.keys(pkg.dependencies ?? {}));
}

export { BASELINE_BUNDLED_RUNTIME_PACKAGES };
