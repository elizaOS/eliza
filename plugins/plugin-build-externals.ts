/**
 * Plugin build helper for deriving Bun.build externals from package metadata.
 *
 * Runtime, peer, optional, and caller-supplied dependencies are externalized so
 * plugin bundles do not inline transitive packages that expect Node internals at
 * top-level import time.
 */

import { readFile } from "node:fs/promises";

export interface ExternalsFromPackageJsonOptions {
  /** Additional externals to merge in (e.g., Node built-ins that aren't auto-detected). */
  extra?: readonly string[];
  /** Externalize peerDependencies too (default: true). */
  includePeer?: boolean;
  /** Externalize optionalDependencies too (default: true). */
  includeOptional?: boolean;
}

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Read a plugin's package.json and produce the list of externals for Bun.build.
 * Every runtime dep is externalized so transitive Node-internal API users
 * (undici, ws, node-fetch, etc.) aren't accidentally inlined and crash at
 * top-level import on platforms (e.g. Bun) that don't expose all of Node's
 * internal modules.
 *
 * The output is sorted to keep diffs stable.
 */
export async function externalsFromPackageJson(
  pkgJsonPath: string,
  options: ExternalsFromPackageJsonOptions = {},
): Promise<string[]> {
  const raw = await readFile(pkgJsonPath, "utf8");
  const pkg = JSON.parse(raw) as PackageJsonShape;
  const includePeer = options.includePeer ?? true;
  const includeOptional = options.includeOptional ?? true;
  const merged = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...(includePeer ? Object.keys(pkg.peerDependencies ?? {}) : []),
    ...(includeOptional ? Object.keys(pkg.optionalDependencies ?? {}) : []),
    ...(options.extra ?? []),
  ]);
  return [...merged].sort();
}
