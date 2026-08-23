/**
 * Colocated unit coverage for `resolveElizaPackageRoot` and
 * `resolveElizaPackageRootSync`. Drives the real module against temporary
 * directory trees — no mocks of the resolver, filesystem, or JSON parse.
 * Pins empty-option miss, cwd/moduleUrl/argv1 hits, ancestor walk, invalid
 * and non-string package names, maxDepth overflow, candidate ordering, and
 * the `node_modules/.bin` shim extra start dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveElizaPackageRoot,
  resolveElizaPackageRootSync,
} from "./eliza-root.ts";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-root-"));
  tempRoots.push(dir);
  return dir;
}

function writePackageJson(dir: string, body: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(body));
}

function writeRawPackageJson(dir: string, contents: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), contents);
}

function nest(from: string, depth: number): string {
  let current = from;
  for (let i = 1; i <= depth; i += 1) {
    current = path.join(current, `n${i}`);
  }
  fs.mkdirSync(current, { recursive: true });
  return current;
}

function fileUrlFor(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
  return pathToFileURL(filePath).href;
}

async function expectBoth(
  opts: { cwd?: string; argv1?: string; moduleUrl?: string },
  expected: string | null,
): Promise<void> {
  expect(resolveElizaPackageRootSync(opts)).toBe(expected);
  expect(await resolveElizaPackageRoot(opts)).toBe(expected);
}

describe("resolveElizaPackageRoot empty and miss paths", () => {
  it("returns null when no candidate dirs are supplied", async () => {
    await expectBoth({}, null);
  });

  it("returns null when cwd has no package.json named eliza within maxDepth", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "not-eliza" });
    await expectBoth({ cwd: nest(root, 2) }, null);
  });

  it("returns null when package.json is missing along the whole walk", async () => {
    const root = makeTempRoot();
    await expectBoth({ cwd: nest(root, 3) }, null);
  });
});

describe("resolveElizaPackageRoot cwd hits", () => {
  it("returns cwd when that directory is the eliza package", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "eliza" });
    await expectBoth({ cwd: root }, root);
  });

  it("walks ancestors from a nested cwd until it finds name eliza", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "eliza" });
    await expectBoth({ cwd: nest(root, 3) }, root);
  });

  it("skips intermediate packages whose name is not exactly eliza", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "eliza" });
    const mid = path.join(root, "packages", "app-core");
    writePackageJson(mid, { name: "@elizaos/app-core" });
    const start = path.join(mid, "src", "utils");
    fs.mkdirSync(start, { recursive: true });
    await expectBoth({ cwd: start }, root);
  });

  it("does not treat Eliza, eliza with trailing space, or @elizaos/eliza as a match", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "Eliza" });
    await expectBoth({ cwd: root }, null);

    const spaced = makeTempRoot();
    writePackageJson(spaced, { name: "eliza " });
    await expectBoth({ cwd: spaced }, null);

    const scoped = makeTempRoot();
    writePackageJson(scoped, { name: "@elizaos/eliza" });
    await expectBoth({ cwd: scoped }, null);
  });

  it("skips a package.json whose name is not a string and keeps walking", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "eliza" });
    const nested = nest(root, 1);
    writePackageJson(nested, { name: 1 });
    await expectBoth({ cwd: nested }, root);
  });

  it("skips invalid JSON and a missing name field and keeps walking", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "eliza" });
    const invalid = nest(root, 1);
    writeRawPackageJson(invalid, "{ not json");
    const unnamed = nest(invalid, 1);
    writePackageJson(unnamed, { version: "1.0.0" });
    await expectBoth({ cwd: unnamed }, root);
  });

  it("finds the package at the last ancestor slot (11 nests under the root)", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "eliza" });
    await expectBoth({ cwd: nest(root, 11) }, root);
  });

  it("returns null when the matching package sits past maxDepth (12 nests)", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "eliza" });
    await expectBoth({ cwd: nest(root, 12) }, null);
  });
});

describe("resolveElizaPackageRoot moduleUrl and argv1", () => {
  it("resolves from a moduleUrl file inside the eliza tree", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "eliza" });
    const moduleUrl = fileUrlFor(path.join(root, "src", "entry.ts"));
    await expectBoth({ moduleUrl }, root);
  });

  it("resolves from argv1 by walking the script directory", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "eliza" });
    const argv1 = path.join(root, "dist", "entry.js");
    fs.mkdirSync(path.dirname(argv1), { recursive: true });
    fs.writeFileSync(argv1, "");
    await expectBoth({ argv1 }, root);
  });

  it("does not add a node_modules/<bin> candidate when argv1 is not a .bin shim", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "other" });
    const hidden = path.join(root, "node_modules", "eliza");
    writePackageJson(hidden, { name: "eliza" });
    const argv1 = path.join(root, "scripts", "eliza");
    fs.mkdirSync(path.dirname(argv1), { recursive: true });
    fs.writeFileSync(argv1, "");
    await expectBoth({ argv1 }, null);
  });

  it("adds node_modules/<binName> when argv1 is a node_modules/.bin shim", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "other" });
    const pkg = path.join(root, "node_modules", "eliza");
    writePackageJson(pkg, { name: "eliza" });
    const argv1 = path.join(root, "node_modules", ".bin", "eliza");
    fs.mkdirSync(path.dirname(argv1), { recursive: true });
    fs.writeFileSync(argv1, "");
    await expectBoth({ argv1 }, pkg);
  });

  it("uses the shim basename as the extra node_modules child, not a hardcoded eliza", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "other" });
    const pkg = path.join(root, "node_modules", "elizaos");
    writePackageJson(pkg, { name: "eliza" });
    const argv1 = path.join(root, "node_modules", ".bin", "elizaos");
    fs.mkdirSync(path.dirname(argv1), { recursive: true });
    fs.writeFileSync(argv1, "");
    await expectBoth({ argv1 }, pkg);
  });

  it("walks up from the .bin directory itself when that already reaches an eliza root", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "eliza" });
    const argv1 = path.join(root, "node_modules", ".bin", "eliza");
    fs.mkdirSync(path.dirname(argv1), { recursive: true });
    fs.writeFileSync(argv1, "");
    await expectBoth({ argv1 }, root);
  });

  it("ignores a .bin path segment that is not immediately under node_modules", async () => {
    const root = makeTempRoot();
    writePackageJson(root, { name: "other" });
    const hidden = path.join(root, "tools", "eliza");
    writePackageJson(hidden, { name: "eliza" });
    const argv1 = path.join(root, "tools", ".bin", "eliza");
    fs.mkdirSync(path.dirname(argv1), { recursive: true });
    fs.writeFileSync(argv1, "");
    await expectBoth({ argv1 }, null);
  });
});

describe("resolveElizaPackageRoot candidate ordering", () => {
  it("prefers moduleUrl over argv1 over cwd when each tree has a different eliza root", async () => {
    const moduleRoot = makeTempRoot();
    writePackageJson(moduleRoot, { name: "eliza" });
    const argvRoot = makeTempRoot();
    writePackageJson(argvRoot, { name: "eliza" });
    const cwdRoot = makeTempRoot();
    writePackageJson(cwdRoot, { name: "eliza" });

    const moduleUrl = fileUrlFor(path.join(moduleRoot, "mod.js"));
    const argv1 = path.join(argvRoot, "bin", "run.js");
    fs.mkdirSync(path.dirname(argv1), { recursive: true });
    fs.writeFileSync(argv1, "");

    await expectBoth({ moduleUrl, argv1, cwd: cwdRoot }, moduleRoot);
    await expectBoth({ argv1, cwd: cwdRoot }, argvRoot);
    await expectBoth({ cwd: cwdRoot }, cwdRoot);
  });

  it("falls through to a later candidate when earlier trees do not contain eliza", async () => {
    const miss = makeTempRoot();
    writePackageJson(miss, { name: "other" });
    const hit = makeTempRoot();
    writePackageJson(hit, { name: "eliza" });

    const moduleUrl = fileUrlFor(path.join(miss, "mod.js"));
    await expectBoth({ moduleUrl, cwd: hit }, hit);
  });

  it("throws when moduleUrl is not a file URL (observed Node fileURLToPath error)", async () => {
    expect(() =>
      resolveElizaPackageRootSync({ moduleUrl: "not-a-url" }),
    ).toThrow();
    await expect(
      resolveElizaPackageRoot({ moduleUrl: "https://example.com/mod.js" }),
    ).rejects.toThrow();
  });
});
