import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertRendererRebuiltSince,
  assertStagedRendererMatchesBuild,
  buildRendererManifest,
  computeRendererFingerprint,
  overlayFreshRendererIntoPublic,
  RENDERER_BUILD_MANIFEST_FILENAME,
  readRendererBuildManifest,
  writeRendererBuildManifest,
} from "./renderer-build-manifest.mjs";
import { resolveElizaWorkspaceRootFromImportMeta } from "./repo-root.mjs";

const repoRoot = resolveElizaWorkspaceRootFromImportMeta(import.meta.url);
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

function removePathRecursive(targetPath: string) {
  execFileSync(process.execPath, [cleanupHelperScript, targetPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-manifest-"));
});

afterEach(() => {
  removePathRecursive(tmp);
});

/**
 * Build a minimal renderer dist dir: index.html + assets/<name>. Mirrors what
 * `vite build` emits (content-hashed asset names + an index.html referencing them).
 */
function makeDist(
  dir: string,
  {
    indexHtml = "<!doctype html><html><body><div id=root></div></body></html>",
    assets = { "index-abc123.js": "console.log(1)" },
  }: { indexHtml?: string; assets?: Record<string, string> } = {},
) {
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), indexHtml);
  for (const [name, body] of Object.entries(assets)) {
    fs.writeFileSync(path.join(dir, "assets", name), body);
  }
}

describe("computeRendererFingerprint", () => {
  it("is deterministic for identical content", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    makeDist(a);
    makeDist(b);
    expect(computeRendererFingerprint(a).buildId).toBe(
      computeRendererFingerprint(b).buildId,
    );
  });

  it("changes when index.html changes", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    makeDist(a);
    makeDist(b, {
      indexHtml: "<!doctype html><html><body>changed</body></html>",
    });
    expect(computeRendererFingerprint(a).buildId).not.toBe(
      computeRendererFingerprint(b).buildId,
    );
  });

  it("changes when an asset is added or renamed (new content hash)", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    makeDist(a, { assets: { "index-abc123.js": "x" } });
    makeDist(b, { assets: { "index-def456.js": "x" } });
    expect(computeRendererFingerprint(a).buildId).not.toBe(
      computeRendererFingerprint(b).buildId,
    );
  });

  it("throws when index.html is missing", () => {
    const a = path.join(tmp, "a");
    fs.mkdirSync(a, { recursive: true });
    expect(() => computeRendererFingerprint(a)).toThrow(/not a built renderer/);
  });
});

describe("writeRendererBuildManifest / readRendererBuildManifest", () => {
  it("round-trips and records metadata", () => {
    const dist = path.join(tmp, "dist");
    makeDist(dist);
    const written = writeRendererBuildManifest(dist, {
      builtAt: "2026-01-01T00:00:00.000Z",
      commit: "deadbeef",
      variant: "store",
      capacitorTarget: "ios",
    });
    expect(
      fs.existsSync(path.join(dist, RENDERER_BUILD_MANIFEST_FILENAME)),
    ).toBe(true);
    const read = readRendererBuildManifest(dist);
    expect(read).toEqual(written);
    expect(read?.variant).toBe("store");
    expect(read?.capacitorTarget).toBe("ios");
    expect(read?.buildId).toBe(computeRendererFingerprint(dist).buildId);
  });

  it("returns null when no manifest is present", () => {
    const dist = path.join(tmp, "dist");
    makeDist(dist);
    expect(readRendererBuildManifest(dist)).toBeNull();
  });
});

describe("assertStagedRendererMatchesBuild", () => {
  it("passes when the staged renderer is a faithful copy of the build", () => {
    const dist = path.join(tmp, "dist");
    const staged = path.join(tmp, "public");
    makeDist(dist);
    writeRendererBuildManifest(dist);
    fs.cpSync(dist, staged, { recursive: true });
    expect(() => assertStagedRendererMatchesBuild(dist, staged)).not.toThrow();
  });

  it("fails when the fresh build has no manifest", () => {
    const dist = path.join(tmp, "dist");
    const staged = path.join(tmp, "public");
    makeDist(dist);
    fs.cpSync(dist, staged, { recursive: true });
    expect(() => assertStagedRendererMatchesBuild(dist, staged)).toThrow(
      /has no eliza-renderer-build\.json/,
    );
  });

  it("fails when the staged renderer has no manifest (stale/missing copy)", () => {
    const dist = path.join(tmp, "dist");
    const staged = path.join(tmp, "public");
    makeDist(dist);
    writeRendererBuildManifest(dist);
    makeDist(staged); // copied bundle but manifest never made it across
    expect(() => assertStagedRendererMatchesBuild(dist, staged)).toThrow(
      /staged renderer .* has no/,
    );
  });

  it("fails loudly when the staged renderer is STALE (different buildId)", () => {
    const dist = path.join(tmp, "dist");
    const staged = path.join(tmp, "public");
    // Stale staged renderer: built earlier from different content.
    makeDist(staged, {
      indexHtml: "<!doctype html><html><body>OLD UI</body></html>",
      assets: { "index-old000.js": "old" },
    });
    writeRendererBuildManifest(staged);
    // Fresh build with new content.
    makeDist(dist, {
      indexHtml: "<!doctype html><html><body>NEW UI</body></html>",
      assets: { "index-new111.js": "new" },
    });
    writeRendererBuildManifest(dist);
    expect(() => assertStagedRendererMatchesBuild(dist, staged)).toThrow(
      /STALE RENDERER/,
    );
  });

  it("fails when the manifest matches but index.html was torn during copy", () => {
    const dist = path.join(tmp, "dist");
    const staged = path.join(tmp, "public");
    makeDist(dist);
    writeRendererBuildManifest(dist);
    fs.cpSync(dist, staged, { recursive: true });
    // Corrupt the staged index.html after the manifest was copied.
    fs.writeFileSync(path.join(staged, "index.html"), "partial");
    expect(() => assertStagedRendererMatchesBuild(dist, staged)).toThrow(
      /partial or stale copy/,
    );
  });
});

describe("overlayFreshRendererIntoPublic", () => {
  it("overlays a stale public with the fresh build and preserves non-dist payloads", () => {
    const dist = path.join(tmp, "dist");
    const pub = path.join(tmp, "public");
    // Fresh build.
    makeDist(dist, {
      indexHtml: "<!doctype html><html><body>NEW</body></html>",
      assets: { "index-new111.js": "new" },
    });
    writeRendererBuildManifest(dist);
    // Stale public with an OLD hashed asset + an on-device agent payload that
    // lives outside dist and must survive the overlay.
    fs.mkdirSync(path.join(pub, "assets"), { recursive: true });
    fs.writeFileSync(path.join(pub, "index.html"), "OLD");
    fs.writeFileSync(path.join(pub, "assets", "index-old000.js"), "old");
    fs.mkdirSync(path.join(pub, "agent"), { recursive: true });
    fs.writeFileSync(path.join(pub, "agent", "agent-bundle.js"), "AGENT");

    overlayFreshRendererIntoPublic(dist, pub, { label: "ios" });

    // Old hashed asset is gone; fresh one is present; index matches.
    expect(fs.existsSync(path.join(pub, "assets", "index-old000.js"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(pub, "assets", "index-new111.js"))).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(pub, "index.html"), "utf8")).toContain(
      "NEW",
    );
    // The agent payload outside dist survived.
    expect(
      fs.readFileSync(path.join(pub, "agent", "agent-bundle.js"), "utf8"),
    ).toBe("AGENT");
    // And it now passes the staged-matches-build assertion.
    expect(() => assertStagedRendererMatchesBuild(dist, pub)).not.toThrow();
  });

  it("throws when the fresh renderer is missing", () => {
    const dist = path.join(tmp, "dist");
    const pub = path.join(tmp, "public");
    fs.mkdirSync(dist, { recursive: true }); // no index.html
    expect(() => overlayFreshRendererIntoPublic(dist, pub)).toThrow(
      /Refusing to stage a missing\/stale UI/,
    );
  });
});

describe("assertRendererRebuiltSince", () => {
  it("passes when the manifest was built during this invocation", () => {
    const dist = path.join(tmp, "dist");
    makeDist(dist);
    const notBefore = Date.now() - 1000;
    writeRendererBuildManifest(dist, { variant: "base" });
    expect(() =>
      assertRendererRebuiltSince(dist, { notBefore, expectVariant: "base" }),
    ).not.toThrow();
  });

  it("fails when the manifest is older than this build (stale dist reused)", () => {
    const dist = path.join(tmp, "dist");
    makeDist(dist);
    writeRendererBuildManifest(dist, {
      builtAt: "2020-01-01T00:00:00.000Z",
    });
    expect(() =>
      assertRendererRebuiltSince(dist, { notBefore: Date.now() }),
    ).toThrow(/STALE/);
  });

  it("fails when the renderer was built for a different variant", () => {
    const dist = path.join(tmp, "dist");
    makeDist(dist);
    const notBefore = Date.now() - 1000;
    writeRendererBuildManifest(dist, { variant: "direct" });
    expect(() =>
      assertRendererRebuiltSince(dist, { notBefore, expectVariant: "store" }),
    ).toThrow(/wrong-variant/);
  });

  it("fails when no manifest exists after the build", () => {
    const dist = path.join(tmp, "dist");
    makeDist(dist);
    expect(() =>
      assertRendererRebuiltSince(dist, { notBefore: Date.now() - 1000 }),
    ).toThrow(/no eliza-renderer-build\.json/);
  });
});

describe("buildRendererManifest", () => {
  it("defaults builtAt to an ISO timestamp and nulls unset metadata", () => {
    const dist = path.join(tmp, "dist");
    makeDist(dist);
    const manifest = buildRendererManifest(dist);
    expect(manifest.schema).toBe("elizaos.renderer.build/v1");
    expect(Number.isFinite(Date.parse(manifest.builtAt))).toBe(true);
    expect(manifest.commit).toBeNull();
    expect(manifest.variant).toBeNull();
    expect(manifest.capacitorTarget).toBeNull();
  });
});
