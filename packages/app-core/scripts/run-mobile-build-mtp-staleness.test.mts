import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mtpSliceReuse } from "./run-mobile-build.mjs";

// Far-future mtimes keep these tests independent of the checkout's own file
// timestamps (the worktree stamps every file at checkout time, including the
// real MTP_BUILD_SCRIPT that mtpSliceReuse folds into its source set).
const FUTURE_ARTIFACT = new Date("2031-01-01T00:00:00Z").getTime();
const OLDER_SOURCE = new Date("2030-01-01T00:00:00Z").getTime();
const NEWER_SOURCE = new Date("2032-01-01T00:00:00Z").getTime();

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtp-staleness-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
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
});
