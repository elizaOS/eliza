import { createRequire } from "node:module";
import process from "node:process";

declare const __MILADY_VERSION__: string | undefined;

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

export function resolveMiladyVersion(moduleUrl: string): string {
  const requireFn = createRequire(moduleUrl);

  return (
    (typeof __MILADY_VERSION__ === "string" && __MILADY_VERSION__) ||
    process.env.MILADY_BUNDLED_VERSION ||
    readVersionFromPackageJson(requireFn) ||
    readVersionFromBuildInfo(requireFn) ||
    "0.0.0"
  );
}
