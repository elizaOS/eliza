/** Exercises workspace change capture against real git repositories and filesystems. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureBaselineDirty,
  captureBaselineSha,
  captureChangeSet,
  parseLsFiles,
  spawnOutputWasTruncated,
  summarizeChangeSet,
  verifyChangedFilesOnDisk,
} from "../services/workspace-diff.js";

describe("workspace diff production paths", () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "workspace-diff-paths-"));
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(dir, "tracked.txt"), "base\n");
    git("add", "tracked.txt");
    git("commit", "-q", "-m", "base");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("captures baseline SHA, pre-existing dirt, and only session changes", async () => {
    const baseline = await captureBaselineSha(dir);
    writeFileSync(join(dir, "tracked.txt"), "dirty before spawn\n");
    expect(await captureBaselineDirty(dir)).toEqual(["tracked.txt"]);
    writeFileSync(join(dir, "session.txt"), "created by tool\n");

    const result = await captureChangeSet(
      dir,
      baseline,
      [join(dir, "session.txt")],
      ["tracked.txt"],
    );
    expect(result?.changedFiles).toEqual(["session.txt"]);
    expect(result?.diff).toContain("created by tool");
    if (!result) throw new Error("expected a captured change set");
    expect(summarizeChangeSet(result)).toContain("Changed 1 file: session.txt");
  });

  it("falls back to tool-path evidence outside git and verifies artifacts", async () => {
    const plain = mkdtempSync(join(tmpdir(), "workspace-diff-plain-"));
    try {
      mkdirSync(join(plain, "src"));
      writeFileSync(join(plain, "src", "new.ts"), "export const x = 1;\n");
      const result = await captureChangeSet(plain, undefined, ["src/new.ts"]);
      expect(result?.diff).toContain("+export const x = 1;");

      const verification = verifyChangedFilesOnDisk(plain, [
        "src/new.ts",
        "missing.ts",
      ]);
      expect(verification.verified).toBe(false);
      expect(verification.files[0]).toMatchObject({
        exists: true,
        kind: "file",
      });
      expect(verification.missingFiles).toEqual(["missing.ts"]);
      if (!result) throw new Error("expected tool-path change evidence");
      expect(summarizeChangeSet(result, verification)).toContain("UNVERIFIED");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("handles an unborn repository and excludes vendor scaffold noise", async () => {
    const unborn = mkdtempSync(join(tmpdir(), "workspace-diff-unborn-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: unborn });
      writeFileSync(join(unborn, "app.ts"), "console.log('app');\n");
      mkdirSync(join(unborn, "node_modules"));
      writeFileSync(join(unborn, "node_modules", "noise.js"), "noise\n");
      const result = await captureChangeSet(unborn);
      expect(result?.changedFiles).toContain("app.ts");
      expect(result?.changedFiles).not.toContain("node_modules/noise.js");
    } finally {
      rmSync(unborn, { recursive: true, force: true });
    }
  });

  it("drops an incomplete ls-files tail AND reports the cut honestly", () => {
    // A listing that does not end where git ended it (no trailing newline)
    // was cut by the read buffer: the garbage half-path is dropped and the
    // cut is REPORTED, never silent — files after the cut are absent and the
    // caller must mark the change set truncated.
    expect(parseLsFiles("one.ts\ntwo.ts\npartial")).toEqual({
      files: ["one.ts", "two.ts"],
      truncated: true,
    });
    expect(parseLsFiles("one.ts\ntwo.ts\n")).toEqual({
      files: ["one.ts", "two.ts"],
      truncated: false,
    });
    expect(parseLsFiles(undefined)).toEqual({ files: [], truncated: false });
  });

  it("a complete capture reports truncated:false (honest, not decorative)", async () => {
    const baseline = await captureBaselineSha(dir);
    writeFileSync(join(dir, "session.txt"), "created by tool\n");
    const result = await captureChangeSet(dir, baseline, [
      join(dir, "session.txt"),
    ]);
    expect(result?.truncated).toBe(false);
  });

  it("spawnOutputWasTruncated detects ENOBUFS and buffer-sized short reads", () => {
    const enobufs = Object.assign(new Error("stdout maxBuffer exceeded"), {
      code: "ENOBUFS",
    });
    expect(spawnOutputWasTruncated(enobufs, 100, 1024)).toBe(true);
    // A read that filled the buffer exactly is a short read: the cut can land
    // on the boundary with no error object.
    expect(spawnOutputWasTruncated(undefined, 1024, 1024)).toBe(true);
    expect(spawnOutputWasTruncated(undefined, 100, 1024)).toBe(false);
    expect(spawnOutputWasTruncated(new Error("other"), 100, 1024)).toBe(false);
  });
});
