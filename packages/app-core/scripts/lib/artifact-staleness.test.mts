import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  artifactStaleness,
  fileMtime,
  maxMtimeUnder,
} from "./artifact-staleness.mjs";
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-staleness-"));
});

afterEach(() => {
  removePathRecursive(tmp);
});

function touch(file: string, mtimeMs: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

describe("maxMtimeUnder", () => {
  it("returns the newest file mtime and skips build/dep dirs", () => {
    touch(path.join(tmp, "src", "a.ts"), 1_000_000);
    touch(path.join(tmp, "src", "nested", "b.ts"), 3_000_000);
    touch(path.join(tmp, "node_modules", "junk.js"), 9_000_000);
    touch(path.join(tmp, "dist", "out.js"), 9_000_000);
    expect(maxMtimeUnder(path.join(tmp, "src"))).toBe(3_000_000);
  });

  it("honors an extension filter", () => {
    touch(path.join(tmp, "src", "a.ts"), 2_000_000);
    touch(path.join(tmp, "src", "a.png"), 5_000_000);
    expect(
      maxMtimeUnder(path.join(tmp, "src"), { exts: new Set([".ts"]) }),
    ).toBe(2_000_000);
  });

  it("returns 0 for a missing dir", () => {
    expect(maxMtimeUnder(path.join(tmp, "nope"))).toBe(0);
  });
});

describe("fileMtime", () => {
  it("returns the mtime of an existing file and 0 for a missing one", () => {
    touch(path.join(tmp, "f"), 4_000_000);
    expect(fileMtime(path.join(tmp, "f"))).toBe(4_000_000);
    expect(fileMtime(path.join(tmp, "missing"))).toBe(0);
  });
});

describe("artifactStaleness", () => {
  it("is stale when the artifact is missing", () => {
    const result = artifactStaleness(path.join(tmp, "art"), {
      sourceDirs: [tmp],
    });
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/artifact missing/);
  });

  it("is stale when a source dir is newer than the artifact", () => {
    touch(path.join(tmp, "artifact"), 2_000_000);
    touch(path.join(tmp, "src", "code.ts"), 5_000_000);
    const result = artifactStaleness(path.join(tmp, "artifact"), {
      sourceDirs: [path.join(tmp, "src")],
    });
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/source newer than artifact/);
    expect(result.newestSource).toBe(path.join(tmp, "src"));
  });

  it("is stale when a source FILE is newer than the artifact", () => {
    touch(path.join(tmp, "artifact"), 2_000_000);
    touch(path.join(tmp, "build-script.mjs"), 6_000_000);
    const result = artifactStaleness(path.join(tmp, "artifact"), {
      sourceFiles: [path.join(tmp, "build-script.mjs")],
    });
    expect(result.stale).toBe(true);
  });

  it("is fresh when the artifact is newer than all sources", () => {
    touch(path.join(tmp, "src", "code.ts"), 2_000_000);
    touch(path.join(tmp, "build-script.mjs"), 1_000_000);
    touch(path.join(tmp, "artifact"), 5_000_000);
    const result = artifactStaleness(path.join(tmp, "artifact"), {
      sourceDirs: [path.join(tmp, "src")],
      sourceFiles: [path.join(tmp, "build-script.mjs")],
    });
    expect(result.stale).toBe(false);
    expect(result.reason).toBe("fresh");
  });
});
