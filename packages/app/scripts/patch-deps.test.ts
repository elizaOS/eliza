/**
 * Keeps the postinstall patches in patch-deps.ts tied to the lockfile: every
 * package, pinned store entry, or require() alias a patch targets must exist
 * in bun.lock, so a patch cannot silently outlive the dependency it fixes.
 * Reads the script as text because importing it applies the patches.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveElizaWorkspaceRootFromImportMeta } from "./lib/repo-root.ts";

const repoRoot = resolveElizaWorkspaceRootFromImportMeta(import.meta.url);
const source = fs.readFileSync(
  new URL("./patch-deps.ts", import.meta.url),
  "utf8",
);
const lock = fs.readFileSync(path.join(repoRoot, "bun.lock"), "utf8");

function targetedPackages() {
  const names = new Set();
  for (const [, name] of source.matchAll(
    /resolve\(\s*root,\s*"node_modules\/((?:@[^/"]+\/)?[^/".]+)"/g,
  )) {
    names.add(name);
  }
  for (const [, name] of source.matchAll(
    /collectInstalledPackageDirs\(\s*"([^"]+)"/g,
  )) {
    names.add(name);
  }
  // Bun store entry prefixes: "<scope>+<name>@" or "<name>@".
  for (const [, entry] of source.matchAll(/startsWith\("([^"]+)@"\)/g)) {
    names.add(entry.replace("+", "/"));
  }
  // require() specifiers a patch writes as a string literal, e.g.
  // `const replacement = 'require("pkg")'`.
  for (const [, name] of source.matchAll(/'require\("([^"]+)"\)'/g)) {
    names.add(name);
  }
  return [...names];
}

function pinnedStoreEntries() {
  return [...source.matchAll(/"((?:@[^+"]+\+)?[^@"+]+@\d+\.\d+\.\d+)"/g)].map(
    ([, entry]) => entry.replace("+", "/"),
  );
}

describe("patch-deps lockfile coverage", () => {
  it("only patches packages present in bun.lock", () => {
    const packages = targetedPackages();
    expect(packages).toContain("jsdom");
    const missing = packages.filter((name) => !lock.includes(`"${name}@`));
    expect(missing).toEqual([]);
  });

  it("only aliases pinned store versions present in bun.lock", () => {
    const missing = pinnedStoreEntries().filter(
      (entry) => !lock.includes(`"${entry}"`),
    );
    expect(missing).toEqual([]);
  });

  it("does not swallow patch failures in a bare catch", () => {
    expect(source).not.toMatch(/\}\s*catch\s*\{\s*\/\/[^\n]*\n\s*\}/);
  });
});
