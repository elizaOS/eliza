import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PackageJson {
  description: string;
  name: string;
  version: string;
}

/**
 * True when running from a `bun build --compile` standalone binary. Bun serves
 * the bundled module graph from a virtual filesystem rooted at `/$bunfs` (older
 * builds used `~BUN`), so `import.meta.url` — and therefore `__dirname` — points
 * inside that virtual root rather than at a real directory on disk. Detecting
 * this lets us resolve on-disk assets (templates, manifest, package.json) next
 * to the real executable instead of at the unreadable bunfs path.
 */
export function isStandaloneBinary(): boolean {
  return __dirname.includes("$bunfs") || __dirname.includes("~BUN");
}

export function getPackageRoot(): string {
  // Standalone binaries ship their templates/, templates-manifest.json, and
  // package.json alongside the executable (see build-standalone.ts), so the
  // "package root" is the directory that contains the running binary.
  if (isStandaloneBinary()) {
    return path.dirname(process.execPath);
  }
  return path.resolve(__dirname, "..");
}

export function readPackageJson(): PackageJson {
  const packagePath = path.join(getPackageRoot(), "package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf-8")) as PackageJson;
}

export function getCliVersion(): string {
  return readPackageJson().version;
}
