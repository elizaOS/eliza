/** Exercises workspace change capture against real git repositories and filesystems. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureBaselineDirty,
  captureBaselineSha,
  captureBaselineUntracked,
  captureChangeSet,
  capturePrGateChangeSet,
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

  it("captures a complete Git diff beyond the former subprocess buffer", async () => {
    git("branch", "review-base");
    const content = `${"complete diff line abcdefghijklmnopqrstuvwxyz 0123456789\n".repeat(180_000)}FINAL_CHANGE_MARKER\n`;
    writeFileSync(join(dir, "tracked.txt"), content);
    const current = await captureChangeSet(dir);
    expect(current?.diff).toContain("+FINAL_CHANGE_MARKER");
    expect(current?.diff).toBe(
      execFileSync("git", ["diff", "HEAD", "--", "tracked.txt"], {
        cwd: dir,
        encoding: "utf8",
        maxBuffer: Buffer.byteLength(content) * 2,
      }),
    );
    git("add", "tracked.txt");
    git("commit", "-q", "-m", "large change");
    const reviewed = await capturePrGateChangeSet(dir, "review-base");
    expect(reviewed?.diff).toBe(current?.diff);
    expect(reviewed?.truncated).toBe(false);
  });

  it("preserves Unicode and whitespace filenames through capture and verification", async () => {
    const names = [
      "snow☃.txt",
      "tab\tname.txt",
      "line\nname.txt",
      " spaced.txt ",
    ];
    for (const name of names) writeFileSync(join(dir, name), "before\n");
    git("add", ".");
    git("commit", "-q", "-m", "path baseline");
    for (const name of names) writeFileSync(join(dir, name), `after ${name}\n`);
    expect(new Set(await captureBaselineDirty(dir))).toEqual(new Set(names));
    const changed = await captureChangeSet(dir);
    expect(new Set(changed?.changedFiles)).toEqual(new Set(names));
    expect(
      verifyChangedFilesOnDisk(dir, changed?.changedFiles ?? []).verified,
    ).toBe(true);
    for (const name of names) {
      for (const line of `after ${name}`.split("\n")) {
        expect(changed?.diff).toContain(`+${line}`);
      }
    }

    const untrackedName = " new\t☃.txt ";
    writeFileSync(join(dir, untrackedName), "untracked content\n");
    expect(await captureBaselineUntracked(dir)).toEqual([untrackedName]);
    const explicit = await captureChangeSet(
      dir,
      undefined,
      [untrackedName],
      names,
    );
    expect(explicit?.changedFiles).toEqual([untrackedName]);
    expect(explicit?.diff).toContain("+untracked content");
  });

  it("reads rename records without treating the original path as another status", async () => {
    const renamed = "renamed\t☃.txt";
    git("mv", "tracked.txt", renamed);
    writeFileSync(join(dir, "next.txt"), "next change\n");
    git("add", "next.txt");
    const changes = await captureChangeSet(dir);
    expect(new Set(changes?.changedFiles)).toEqual(
      new Set([renamed, "next.txt"]),
    );
    expect(changes?.diff).toContain("+base");
    expect(changes?.diff).toContain("+next change");
    expect(await captureBaselineUntracked(dir)).toEqual([]);
  });

  it("keeps non-repository and unborn baselines distinct from command failures", async () => {
    const plain = mkdtempSync(join(tmpdir(), "workspace-diff-empty-"));
    try {
      expect(await captureBaselineSha(plain)).toBeUndefined();
      expect(await captureBaselineDirty(plain)).toEqual([]);
      expect(await capturePrGateChangeSet(plain, "main")).toBeUndefined();
      execFileSync("git", ["init", "-q"], { cwd: plain });
      expect(await captureBaselineSha(plain)).toBeUndefined();
      expect(await captureBaselineDirty(plain)).toEqual([]);
      writeFileSync(join(plain, "new\t☃.txt"), "fresh file\n");
      const unborn = await captureChangeSet(plain);
      expect(unborn?.changedFiles).toEqual(["new\t☃.txt"]);
      expect(unborn?.diff).toContain("+fresh file");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    await expect(
      captureChangeSet(dir, "missing-base-ref"),
    ).rejects.toMatchObject({
      code: "WORKSPACE_GIT_COMMAND_FAILED",
    });
    await expect(
      captureBaselineSha(join(dir, "missing-dir")),
    ).rejects.toMatchObject({
      code: "WORKSPACE_GIT_CAPTURE_FAILED",
    });
  });

  it("rejects failed Git output even when an external diff emitted a prefix", async () => {
    git("branch", "review-base");
    writeFileSync(join(dir, "tracked.txt"), "after\n");
    git("add", "tracked.txt");
    git("commit", "-q", "-m", "change");
    const helper = join(dir, "failed-diff.sh");
    writeFileSync(
      helper,
      "#!/bin/sh\nprintf 'partial diff output\\n'\nexit 2\n",
      {
        mode: 0o700,
      },
    );
    git("config", "diff.external", helper);
    await expect(
      capturePrGateChangeSet(dir, "review-base"),
    ).rejects.toMatchObject({
      code: "WORKSPACE_GIT_COMMAND_FAILED",
    });
  });

  it("uses one direct comparison when the histories have no merge base", async () => {
    git("branch", "review-base");
    git("checkout", "--orphan", "independent");
    git("rm", "-q", "-f", "tracked.txt");
    writeFileSync(join(dir, "independent.txt"), "independent history\n");
    git("add", "independent.txt");
    git("commit", "-q", "-m", "independent base");
    const reviewed = await capturePrGateChangeSet(dir, "review-base");
    expect(new Set(reviewed?.changedFiles)).toEqual(
      new Set(["independent.txt", "tracked.txt"]),
    );
    expect(reviewed?.diff).toContain("+independent history");
    expect(reviewed?.diff).toContain("-base");
    await expect(
      capturePrGateChangeSet(dir, "missing-base-ref"),
    ).rejects.toMatchObject({
      code: "WORKSPACE_GIT_COMMAND_FAILED",
    });
  });
});
