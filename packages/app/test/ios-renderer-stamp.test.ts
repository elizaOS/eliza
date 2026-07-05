import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertIosAppRendererFresh,
  compareRendererBuildIds,
  rendererManifestPathFromAppPath,
} from "../scripts/lib/ios-renderer-stamp.mjs";

const tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ios-renderer-stamp-"));
  tempDirs.push(dir);
  return dir;
}

function writeAppManifest(appPath: string, buildId: string) {
  mkdirSync(path.join(appPath, "public"), { recursive: true });
  writeFileSync(
    rendererManifestPathFromAppPath(appPath),
    JSON.stringify({ buildId, builtAt: "2026-07-04T00:00:00.000Z" }),
  );
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
        fresh: { buildId: "abc", builtAt: "now" },
        installed: { buildId: "abc" },
        label: "candidate app",
      }),
    ).toEqual({ buildId: "abc", builtAt: "now" });
  });

  it("rejects stale installed renderer manifests", () => {
    expect(() =>
      compareRendererBuildIds({
        fresh: { buildId: "fresh" },
        installed: { buildId: "old" },
        label: "installed app",
      }),
    ).toThrow(/stale UI install/);
  });

  it("compares a candidate app bundle against the freshly built dist manifest", () => {
    const repoRoot = tempDir();
    const appPath = path.join(repoRoot, "Candidate.app");
    const dist = path.join(repoRoot, "packages", "app", "dist");
    mkdirSync(dist, { recursive: true });
    writeAppManifest(appPath, "same");
    writeFileSync(
      path.join(dist, "eliza-renderer-build.json"),
      JSON.stringify({ buildId: "same", builtAt: "later" }),
    );

    expect(assertIosAppRendererFresh({ appPath, repoRoot })).toEqual({
      buildId: "same",
      builtAt: "later",
    });
  });
});
