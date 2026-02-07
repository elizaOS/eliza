import { createRequire } from "node:module";

declare const __MILAIDY_VERSION__: string | undefined;

function readVersionFromPackageJson(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function readVersionFromBuildInfo(): string | null {
  const req = createRequire(import.meta.url);
  for (const candidate of ["../build-info.json", "./build-info.json"]) {
    try {
      const info = req(candidate) as { version?: string };
      if (info.version) return info.version;
    } catch {
      // ignore missing candidate
    }
  }
  return null;
}

// Single source of truth for the current Milaidy version.
// - Embedded/bundled builds: injected define or env var.
// - Dev/npm builds: package.json.
export const VERSION =
  (typeof __MILAIDY_VERSION__ === "string" && __MILAIDY_VERSION__) ||
  process.env.MILAIDY_BUNDLED_VERSION ||
  readVersionFromPackageJson() ||
  readVersionFromBuildInfo() ||
  "0.0.0";
