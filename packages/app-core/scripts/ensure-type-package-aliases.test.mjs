/**
 * Locks the lockfile-pin contract of the type-package materializer: the bun
 * cache is machine-global and accumulates versions from every checkout on the
 * host, so cache selection must prefer the bun.lock-pinned version and never
 * stomp a correctly installed pin with a newer cached copy (a cached
 * @types/node@26.x once broke every packages/core build whose lockfile pinned
 * 25.x). Deterministic filesystem fixtures; no network, no real bun cache.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  findCachedPackageDir,
  readLockfilePinnedVersions,
} from "./ensure-type-package-aliases.mjs";

const cleanups = [];

afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop(), { recursive: true, force: true });
  }
});

function makeFixtureDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "type-aliases-test-"));
  cleanups.push(dir);
  return dir;
}

function makeCacheDir(entries) {
  const dir = makeFixtureDir();
  for (const entry of entries) {
    mkdirSync(path.join(dir, entry), { recursive: true });
  }
  return dir;
}

describe("readLockfilePinnedVersions", () => {
  it("reads root resolutions and ignores nested per-parent resolutions", () => {
    const dir = makeFixtureDir();
    const lockfilePath = path.join(dir, "bun.lock");
    // Shape copied from a real bun.lock packages section (JSONC, trailing
    // commas): root entries key the bare name; nested entries key
    // "<parent>/<name>" and must not win over the root pin.
    writeFileSync(
      lockfilePath,
      [
        "{",
        '  "packages": {',
        '    "@types/node": ["@types/node@25.6.2", "", { "dependencies": { "undici-types": "~7.19.0" } }, "sha512-root"],',
        '    "bun-types": ["bun-types@1.3.14", "", { "dependencies": { "@types/node": "*" } }, "sha512-bun"],',
        '    "some-parent/@types/node": ["@types/node@26.1.1", "", {}, "sha512-nested"],',
        "  },",
        "}",
      ].join("\n"),
      "utf8",
    );

    const pins = readLockfilePinnedVersions(lockfilePath);
    expect(pins.get("@types/node")).toBe("25.6.2");
    expect(pins.get("bun-types")).toBe("1.3.14");
    expect(pins.has("some-parent/@types/node")).toBe(false);
  });

  it("returns no pins when the lockfile does not exist", () => {
    const pins = readLockfilePinnedVersions(
      path.join(makeFixtureDir(), "missing", "bun.lock"),
    );
    expect(pins.size).toBe(0);
  });
});

describe("findCachedPackageDir", () => {
  it("prefers the pinned version over a numerically newer cache entry", () => {
    const cacheDir = makeCacheDir(["node@25.6.2", "node@26.1.1"]);
    expect(findCachedPackageDir(cacheDir, "node", "25.6.2")).toBe(
      path.join(cacheDir, "node@25.6.2"),
    );
  });

  it("matches pinned cache entries that carry a registry suffix", () => {
    const cacheDir = makeCacheDir([
      "node@25.6.2@@registry.npmjs.org",
      "node@26.1.1",
    ]);
    expect(findCachedPackageDir(cacheDir, "node", "25.6.2")).toBe(
      path.join(cacheDir, "node@25.6.2@@registry.npmjs.org"),
    );
  });

  it("keeps the installed copy (null) when the pin is not cached", () => {
    const cacheDir = makeCacheDir(["node@26.1.1"]);
    expect(findCachedPackageDir(cacheDir, "node", "25.6.2")).toBeNull();
  });

  it("falls back to the newest cache entry when nothing is pinned", () => {
    const cacheDir = makeCacheDir(["node@25.6.2", "node@26.1.1"]);
    expect(findCachedPackageDir(cacheDir, "node", undefined)).toBe(
      path.join(cacheDir, "node@26.1.1"),
    );
  });

  it("does not confuse a package prefix with a longer package name", () => {
    const cacheDir = makeCacheDir(["node-fetch@2.7.0"]);
    expect(findCachedPackageDir(cacheDir, "node", undefined)).toBeNull();
  });
});
