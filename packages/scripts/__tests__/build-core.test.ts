import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_CORE_PREREQUISITE_SCRIPTS,
  buildCoreTurboArgs,
} from "../build-core.mjs";
import { CORE_BUILD_PACKAGES } from "../build-core-packages.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".git",
  "coverage",
  "build",
  "out",
]);

/** Collect every workspace package `name` under packages/ + plugins/. */
function collectWorkspacePackageNames() {
  const names = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name === "package.json") {
        try {
          const pkg = JSON.parse(readFileSync(full, "utf8")) as {
            name?: string;
          };
          if (pkg.name) names.add(pkg.name);
        } catch {
          // A malformed package.json is not a workspace package name source.
        }
      }
    }
  };
  for (const base of ["packages", "plugins"]) {
    walk(path.join(REPO_ROOT, base), 0);
  }
  return names;
}

function rootBuildCoreScript(): string {
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  return pkg.scripts?.["build:core"] ?? "";
}

function corePrebuildScript(): string {
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "packages/core/package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  return pkg.scripts?.prebuild ?? "";
}

describe("build-core package set (issue #10200)", () => {
  test("every core package resolves to a real workspace package (drift guard)", () => {
    const workspaceNames = collectWorkspacePackageNames();
    const missing = CORE_BUILD_PACKAGES.filter(
      (name) => !workspaceNames.has(name),
    );
    expect(
      missing,
      `build-core-packages.mjs lists package(s) that no longer exist in the ` +
        `workspace: ${missing.join(", ")}. Remove or rename them.`,
    ).toEqual([]);
  });

  test("the core set has no duplicate entries", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const name of CORE_BUILD_PACKAGES) {
      if (seen.has(name)) dupes.push(name);
      seen.add(name);
    }
    expect(dupes, `duplicate core packages: ${dupes.join(", ")}`).toEqual([]);
  });

  test("the core set is non-empty and only names @elizaos packages", () => {
    expect(CORE_BUILD_PACKAGES.length).toBeGreaterThan(0);
    const foreign = CORE_BUILD_PACKAGES.filter(
      (name) => !name.startsWith("@elizaos/"),
    );
    expect(foreign, `non-@elizaos entries: ${foreign.join(", ")}`).toEqual([]);
  });

  test("buildCoreTurboArgs emits one --filter per package over `run build`", () => {
    const args = buildCoreTurboArgs();
    expect(args.slice(0, 2)).toEqual(["run", "build"]);
    const filters = args.filter((a) => a.startsWith("--filter="));
    expect(filters).toEqual(
      CORE_BUILD_PACKAGES.map((name) => `--filter=${name}`),
    );
    // No stray args beyond `run build` + the per-package filters.
    expect(args.length).toBe(2 + CORE_BUILD_PACKAGES.length);
  });

  test("buildCoreTurboArgs forwards extra turbo args after the filters", () => {
    const args = buildCoreTurboArgs(["--force"]);
    expect(args.at(-1)).toBe("--force");
  });

  test("build:core repairs workspace links before invoking turbo", () => {
    expect(BUILD_CORE_PREREQUISITE_SCRIPTS).toContain(
      "ensure-workspace-symlinks.mjs",
    );
  });

  test("root build:core delegates to the driver (no re-inlined --filter list)", () => {
    const body = rootBuildCoreScript();
    expect(body).toBe("node packages/scripts/build-core.mjs");
    // Guard against regressing to the hand-maintained inline flag wall.
    expect(body).not.toContain("--filter=");
  });

  test("package-local core build prepares logger before core declarations", () => {
    const body = corePrebuildScript();
    expect(body).toContain("bun run --cwd ../logger build");
    expect(body.indexOf("../logger build")).toBeLessThan(
      body.indexOf("../contracts build"),
    );
  });
});
