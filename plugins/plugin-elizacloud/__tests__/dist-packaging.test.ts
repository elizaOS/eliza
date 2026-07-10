/**
 * Packaging regression coverage for the built package (#15779): proves the
 * exports map's dist entries are honest under default (non-`eliza-source`)
 * resolution. Asserts every dist file referenced from package.json exports
 * exists, the declaration alias shims re-export through NodeNext-safe
 * explicit-`.js` specifiers whose `.d.ts` targets are on disk, the Windows
 * glob-separator filter regression stays fixed (no vite-only components or
 * duplicate root entrypoints in dist), and a child Node process with default
 * conditions resolves the bare package name to the real built entry. Runs
 * against a fresh real `build.ts` run inside the test process so changed-source
 * coverage and the asserted artifacts describe the same build.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(packageRoot, "dist");

const SHIM_FILES = ["node/index.d.ts", "browser/index.d.ts", "cjs/index.d.ts"] as const;

function distFile(relative: string): string {
  return path.join(distDir, relative);
}

function readShimSpecifiers(shimRelPath: string): string[] {
  const source = readFileSync(distFile(shimRelPath), "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/** Collects every relative-path leaf in an exports value, skipping the named condition. */
function collectExportTargets(value: unknown, skipCondition: string, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [condition, nested] of Object.entries(value)) {
      if (condition === skipCondition) continue;
      collectExportTargets(nested, skipCondition, out);
    }
  }
}

beforeAll(async () => {
  // Importing the build entry keeps the real build inside the test process, so
  // the changed-source coverage gate can observe the production path it proves.
  const previousCwd = process.cwd();
  process.chdir(packageRoot);
  try {
    await import("../build.ts");
  } finally {
    process.chdir(previousCwd);
  }
}, 300_000);

describe("dist packaging (#15779)", () => {
  it("every dist file referenced from package.json exports exists", () => {
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const targets: string[] = [];
    collectExportTargets(packageJson.exports["."], "eliza-source", targets);
    for (const field of ["main", "module", "types", "browser"]) {
      if (typeof packageJson[field] === "string") targets.push(packageJson[field]);
    }
    const missing = targets.filter((t) => !existsSync(path.join(packageRoot, t)));
    expect(missing, `exports reference missing files: ${missing.join(", ")}`).toEqual([]);
  });

  it("declaration alias shims use explicit-.js specifiers with emitted .d.ts targets", () => {
    for (const shim of SHIM_FILES) {
      expect(existsSync(distFile(shim)), `missing shim ${shim}`).toBe(true);
      const specifiers = readShimSpecifiers(shim);
      expect(specifiers.length, `${shim} has no re-exports`).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        // NodeNext resolution rejects extensionless relative paths, so the shim
        // must name the runtime file; TS maps it to the .d.ts sibling.
        expect(specifier, `${shim} specifier must be relative`).toMatch(/^\.{1,2}\//);
        expect(specifier, `${shim} specifier must be NodeNext-safe`).toMatch(/\.js$/);
        const declTarget = path.resolve(
          path.dirname(distFile(shim)),
          specifier.replace(/\.js$/, ".d.ts")
        );
        expect(existsSync(declTarget), `${shim} re-exports missing ${declTarget}`).toBe(true);
      }
    }
  });

  it("dist carries no vite-only components and no duplicate root entrypoints", () => {
    // These appear only when the build's subpath filters fail (the Windows
    // backslash-separator regression); a healthy build never emits them.
    expect(existsSync(distFile("components"))).toBe(false);
    expect(existsSync(distFile("index.node.js"))).toBe(false);
    expect(existsSync(distFile("index.browser.js"))).toBe(false);
  });

  it("a default-conditions Node process resolves the bare package to the built node entry", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        "process.stdout.write(import.meta.resolve('@elizaos/plugin-elizacloud'));",
      ],
      { cwd: packageRoot, encoding: "utf8", timeout: 60_000 }
    );
    expect(result.status, `resolution failed: ${result.stderr}`).toBe(0);
    const resolved = fileURLToPath(result.stdout.trim());
    expect(path.normalize(resolved)).toBe(path.normalize(distFile("node/index.node.js")));
    expect(existsSync(resolved)).toBe(true);
  });
});
