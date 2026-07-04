/**
 * Resolves the running Eliza package version from the first available source:
 * the build-injected `__ELIZA_VERSION__` global, the `ELIZA_BUNDLED_VERSION`
 * env var, the package's `package.json`, then a `build-info.json` candidate,
 * falling back to `"0.0.0"`. Module-not-found errors on the optional file
 * lookups are swallowed so a stripped-down bundle still resolves; any other
 * require error propagates.
 */
import { createRequire } from "node:module";
import process from "node:process";

declare const __ELIZA_VERSION__: string | undefined;

const PACKAGE_JSON_CANDIDATE = "../../package.json";
const BUILD_INFO_CANDIDATES = [
  "../../build-info.json",
  "../build-info.json",
  "./build-info.json",
] as const;

function isModuleNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
  );
}

function readVersionFromPackageJson(requireFn: NodeRequire): string | null {
  try {
    const pkg = requireFn(PACKAGE_JSON_CANDIDATE) as { version?: string };
    return pkg.version ?? null;
  } catch (err) {
    if (isModuleNotFound(err)) {
      return null;
    }
    throw err;
  }
}

function readVersionFromBuildInfo(requireFn: NodeRequire): string | null {
  for (const candidate of BUILD_INFO_CANDIDATES) {
    try {
      const info = requireFn(candidate) as { version?: string };
      if (info.version) {
        return info.version;
      }
    } catch (err) {
      if (!isModuleNotFound(err)) {
        throw err;
      }
    }
  }
  return null;
}

export function resolveElizaVersion(moduleUrl: string): string {
  const requireFn = createRequire(moduleUrl);

  return (
    (typeof __ELIZA_VERSION__ === "string" && __ELIZA_VERSION__) ||
    process.env.ELIZA_BUNDLED_VERSION ||
    readVersionFromPackageJson(requireFn) ||
    readVersionFromBuildInfo(requireFn) ||
    "0.0.0"
  );
}
