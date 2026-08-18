/**
 * Deterministic coverage for exact-build renderer stamps in staged and
 * installed iOS Simulator applications.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertIosAppRendererFresh,
  compareRendererBuildIds,
  freshRendererManifestPath,
  readRendererManifest,
  rendererManifestPathFromAppPath,
} from "../scripts/lib/ios-renderer-stamp.mjs";

const tempDirs: string[] = [];
const CURRENT_COMMIT = "a".repeat(40);
const STALE_COMMIT = "b".repeat(40);

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ios-renderer-stamp-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("iOS renderer stamp", () => {
  it("accepts matching fresh and installed build ids", () => {
    expect(
      compareRendererBuildIds({
        fresh: { buildId: "abc", commit: CURRENT_COMMIT, builtAt: "now" },
        installed: { buildId: "abc", commit: CURRENT_COMMIT },
        label: "candidate app",
        expectedCommit: CURRENT_COMMIT,
      }),
    ).toEqual({ buildId: "abc", commit: CURRENT_COMMIT, builtAt: "now" });
  });

  it("rejects stale installed renderer manifests", () => {
    expect(() =>
      compareRendererBuildIds({
        fresh: { buildId: "fresh" },
        installed: { buildId: "old" },
        label: "installed app",
        expectedCommit: CURRENT_COMMIT,
      }),
    ).toThrow(/stale UI install/);
  });

  it("rejects equal build ids carrying different commits", () => {
    expect(() =>
      compareRendererBuildIds({
        fresh: { buildId: "same", commit: CURRENT_COMMIT },
        installed: { buildId: "same", commit: STALE_COMMIT },
        label: "installed app",
        expectedCommit: CURRENT_COMMIT,
      }),
    ).toThrow(/inconsistent build stamp/);
  });

  it("rejects an absent installed commit when exact-head evidence is required", () => {
    expect(() =>
      compareRendererBuildIds({
        fresh: { buildId: "same", commit: CURRENT_COMMIT },
        installed: { buildId: "same", commit: null },
        expectedCommit: CURRENT_COMMIT,
      }),
    ).toThrow(/has no full commit SHA/);
  });

  it("rejects stale or malformed commits even when build ids match", () => {
    for (const commit of [STALE_COMMIT, CURRENT_COMMIT.slice(0, 12), null]) {
      expect(() =>
        compareRendererBuildIds({
          fresh: { buildId: "same", commit: CURRENT_COMMIT },
          installed: { buildId: "same", commit },
          expectedCommit: CURRENT_COMMIT,
        }),
      ).toThrow();
    }
    expect(() =>
      compareRendererBuildIds({
        fresh: { buildId: "same", commit: CURRENT_COMMIT },
        installed: { buildId: "same", commit: CURRENT_COMMIT },
        expectedCommit: "not-a-sha",
      }),
    ).toThrow(/not a full SHA-1/);
  });

  it("compares a candidate app bundle against the freshly built dist manifest", () => {
    const repoRoot = tempDir();
    const appPath = path.join(repoRoot, "Candidate.app");
    const dist = path.join(repoRoot, "packages", "app", "dist");
    mkdirSync(dist, { recursive: true });
    mkdirSync(path.join(appPath, "public"), { recursive: true });
    writeFileSync(
      rendererManifestPathFromAppPath(appPath),
      JSON.stringify({
        buildId: "same",
        commit: CURRENT_COMMIT,
        builtAt: "2026-07-04T00:00:00.000Z",
      }),
    );
    writeFileSync(
      path.join(dist, "eliza-renderer-build.json"),
      JSON.stringify({
        buildId: "same",
        commit: CURRENT_COMMIT,
        builtAt: "later",
      }),
    );

    expect(
      assertIosAppRendererFresh({
        appPath,
        repoRoot,
        expectedCommit: CURRENT_COMMIT,
      }),
    ).toEqual({
      buildId: "same",
      commit: CURRENT_COMMIT,
      builtAt: "later",
    });
  });

  it("rejects consistently stale dist and app bundles", () => {
    const repoRoot = tempDir();
    const appPath = path.join(repoRoot, "Candidate.app");
    const dist = path.join(repoRoot, "packages", "app", "dist");
    mkdirSync(dist, { recursive: true });
    mkdirSync(path.join(appPath, "public"), { recursive: true });
    for (const manifestPath of [
      rendererManifestPathFromAppPath(appPath),
      path.join(dist, "eliza-renderer-build.json"),
    ]) {
      writeFileSync(
        manifestPath,
        JSON.stringify({ buildId: "same", commit: STALE_COMMIT }),
      );
    }

    expect(() =>
      assertIosAppRendererFresh({
        appPath,
        repoRoot,
        expectedCommit: CURRENT_COMMIT,
      }),
    ).toThrow(/must both match HEAD/);
  });
});

describe("readRendererManifest", () => {
  it("normalizes the stamp to typed buildId/commit/variant/runtimeMode/builtAt", () => {
    const dir = tempDir();
    const target = path.join(dir, "eliza-renderer-build.json");
    writeFileSync(
      target,
      JSON.stringify({
        buildId: "build-XYZ",
        commit: "deadbeef",
        variant: "device",
        runtimeMode: "local",
        builtAt: "2026-01-01T00:00:00Z",
      }),
    );
    expect(readRendererManifest(target, "staged")).toEqual({
      buildId: "build-XYZ",
      commit: "deadbeef",
      variant: "device",
      runtimeMode: "local",
      builtAt: "2026-01-01T00:00:00Z",
    });
  });

  it("defaults absent optional fields to null (not the raw undefined)", () => {
    const dir = tempDir();
    const target = path.join(dir, "eliza-renderer-build.json");
    writeFileSync(target, JSON.stringify({ buildId: "only-build-id" }));
    expect(readRendererManifest(target, "staged")).toEqual({
      buildId: "only-build-id",
      commit: null,
      variant: null,
      runtimeMode: null,
      builtAt: null,
    });
  });

  it("throws on a missing manifest", () => {
    const dir = tempDir();
    expect(() =>
      readRendererManifest(path.join(dir, "nope.json"), "staged"),
    ).toThrow(/is missing/);
  });

  it("throws on a manifest with no buildId", () => {
    const dir = tempDir();
    const target = path.join(dir, "eliza-renderer-build.json");
    writeFileSync(target, JSON.stringify({ commit: "x" }));
    expect(() => readRendererManifest(target, "staged")).toThrow(
      /has no buildId/,
    );
  });
});

describe("freshRendererManifestPath", () => {
  it("honors an explicit dist override", () => {
    expect(
      freshRendererManifestPath({
        repoRoot: "/repo",
        rendererDist: "/custom/dist",
      }),
    ).toBe(path.join("/custom", "dist", "eliza-renderer-build.json"));
  });
  it("defaults to packages/app/dist under the repo root", () => {
    expect(freshRendererManifestPath({ repoRoot: "/repo" })).toBe(
      path.join(
        "/repo",
        "packages",
        "app",
        "dist",
        "eliza-renderer-build.json",
      ),
    );
  });
});
