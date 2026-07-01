import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MTP_FORK_SRC_CANDIDATES,
  mtpBuilderRepoRoot,
  mtpForceRebuildRequested,
  mtpSliceReuse,
} from "./lib/mobile-build-decisions.mjs";
import { resolveElizaWorkspaceRootFromImportMeta } from "./lib/repo-root.mjs";

// Far-future mtimes keep these tests independent of the checkout's own file
// timestamps (the worktree stamps every file at checkout time, including the
// real MTP_BUILD_SCRIPT that mtpSliceReuse folds into its source set).
const FUTURE_ARTIFACT = new Date("2031-01-01T00:00:00Z").getTime();
const OLDER_SOURCE = new Date("2030-01-01T00:00:00Z").getTime();
const NEWER_SOURCE = new Date("2032-01-01T00:00:00Z").getTime();

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtp-staleness-"));
});

afterEach(() => {
  removePathRecursive(tmp);
});

function touch(file: string, mtimeMs: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

function makeForkSrc(sourceMtime: number) {
  const fork = path.join(tmp, "fork");
  touch(path.join(fork, "CMakeLists.txt"), sourceMtime);
  touch(path.join(fork, "ggml", "src", "ggml.c"), sourceMtime);
  touch(path.join(fork, "src", "llama.cpp"), sourceMtime);
  return fork;
}

function writeCapabilities(revision: string | null, mtimeMs: number) {
  const outDir = path.join(tmp, "mtp-out");
  const capabilities = path.join(outDir, "CAPABILITIES.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(capabilities, JSON.stringify({ fork: { revision } }));
  fs.utimesSync(capabilities, mtimeMs / 1000, mtimeMs / 1000);
  return capabilities;
}

describe("mtpSliceReuse", () => {
  it("is not reusable when CAPABILITIES.json is missing", () => {
    const fork = makeForkSrc(OLDER_SOURCE);
    const result = mtpSliceReuse(
      path.join(tmp, "mtp-out", "CAPABILITIES.json"),
      fork,
      "rev-a",
    );
    expect(result.reusable).toBe(false);
    expect(result.reason).toMatch(/no CAPABILITIES\.json/);
  });

  it("is not reusable when the fork revision changed", () => {
    const fork = makeForkSrc(OLDER_SOURCE);
    const caps = writeCapabilities("rev-a", FUTURE_ARTIFACT);
    const result = mtpSliceReuse(caps, fork, "rev-b");
    expect(result.reusable).toBe(false);
    expect(result.reason).toMatch(/fork revision changed/);
  });

  it("is not reusable when a fork source is newer than the artifact (stale kernels)", () => {
    const fork = makeForkSrc(NEWER_SOURCE);
    const caps = writeCapabilities("rev-a", FUTURE_ARTIFACT);
    const result = mtpSliceReuse(caps, fork, "rev-a");
    expect(result.reusable).toBe(false);
    expect(result.reason).toMatch(/source newer than artifact/);
  });

  it("is reusable when revision matches and the artifact is newer than sources", () => {
    const fork = makeForkSrc(OLDER_SOURCE);
    const caps = writeCapabilities("rev-a", FUTURE_ARTIFACT);
    const result = mtpSliceReuse(caps, fork, "rev-a");
    expect(result.reusable).toBe(true);
    expect(result.reason).toBe("fresh");
  });

  it("falls back to the mtime check (not a forced rebuild) when git revision is unknown", () => {
    const fork = makeForkSrc(OLDER_SOURCE);
    const caps = writeCapabilities("rev-a", FUTURE_ARTIFACT);
    // currentRevision unknown (git failed in CI) → revision check is skipped,
    // and the fresh mtime keeps the slice reusable rather than rebuilding blindly.
    const result = mtpSliceReuse(caps, fork, null);
    expect(result.reusable).toBe(true);
  });

  it("does NOT spuriously rebuild when the recorded revision is the 'unknown' sentinel", () => {
    const fork = makeForkSrc(OLDER_SOURCE);
    // Slice built when git was unavailable → recorded "unknown"; now git works
    // and returns a real SHA. The "unknown" sentinel must normalize to null so
    // it falls through to the (fresh) mtime check instead of rebuilding.
    const caps = writeCapabilities("unknown", FUTURE_ARTIFACT);
    const result = mtpSliceReuse(caps, fork, "v1.2.3-real-sha");
    expect(result.reusable).toBe(true);
  });

  it("still catches a stale slice even when the recorded revision is 'unknown'", () => {
    const fork = makeForkSrc(NEWER_SOURCE);
    const caps = writeCapabilities("unknown", FUTURE_ARTIFACT);
    const result = mtpSliceReuse(caps, fork, "v1.2.3-real-sha");
    expect(result.reusable).toBe(false);
    expect(result.reason).toMatch(/source newer than artifact/);
  });
});

describe("MTP_FORK_SRC_CANDIDATES (no drift vs the builder)", () => {
  it("mirrors build-llama-cpp-mtp.mjs: the in-repo fork + the ios-deps fallback, and nothing divergent", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const expectedRepoRoot = path.resolve(here, "..", "..", "..");
    const forkSuffix = path.join(
      "plugins",
      "plugin-local-inference",
      "native",
      "llama.cpp",
    );
    const iosDepsSuffix = path.join(
      "packages",
      "native",
      "ios-deps",
      "llama.cpp",
      "src",
    );

    expect(expectedRepoRoot).toBe(mtpBuilderRepoRoot);
    expect(MTP_FORK_SRC_CANDIDATES).toEqual(
      [
        process.env.ELIZA_MTP_LLAMA_CPP_SRC?.trim(),
        path.join(
          repoRoot,
          "plugins",
          "plugin-local-inference",
          "native",
          "llama.cpp",
        ),
        path.join(
          repoRoot,
          "packages",
          "native",
          "ios-deps",
          "llama.cpp",
          "src",
        ),
      ].filter(Boolean),
    );
    expect(MTP_FORK_SRC_CANDIDATES.some((c) => c.endsWith(forkSuffix))).toBe(
      true,
    );
    expect(MTP_FORK_SRC_CANDIDATES.some((c) => c.endsWith(iosDepsSuffix))).toBe(
      true,
    );
    // The previously-divergent `eliza/plugins` candidate (absent from the
    // builder) must NOT reappear — that was the drift the builder never had.
    // Check the path RELATIVE to the repo root: the legit candidate resolves to
    // `plugins/plugin-local-inference/…`; the old divergent one resolved to a
    // nested `eliza/plugins/plugin-local-inference/…`. (An absolute substring
    // check false-positives because the repo root itself is named `eliza`.)
    expect(
      MTP_FORK_SRC_CANDIDATES.some((c) =>
        path
          .relative(mtpBuilderRepoRoot, c)
          .includes(path.join("eliza", "plugins", "plugin-local-inference")),
      ),
    ).toBe(false);
  });
});

describe("mtpForceRebuildRequested", () => {
  it("does NOT force a rebuild for a fresh, reusable slice", () => {
    expect(mtpForceRebuildRequested({ reusable: true }, {})).toBe(false);
  });

  it("forces a rebuild when the slice is stale (so the child does not reuse it)", () => {
    expect(
      mtpForceRebuildRequested({ reusable: false, reason: "stale" }, {}),
    ).toBe(true);
  });

  it("forces a rebuild when the operator override is set, even if reusable", () => {
    expect(
      mtpForceRebuildRequested(
        { reusable: true },
        { ELIZA_IOS_REBUILD_MTP: "1" },
      ),
    ).toBe(true);
  });
});
