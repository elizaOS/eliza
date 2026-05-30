import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  captureBaselineDirty,
  captureBaselineSha,
  captureChangeSet,
  summarizeChangeSet,
} from "../../src/services/workspace-diff.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("workspace-diff — real git capture", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsdiff-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@t.t"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, "index.html"), "<h1>placeholder</h1>\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures the HEAD sha as baseline inside a work tree", async () => {
    const sha = await captureBaselineSha(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns undefined baseline outside a git work tree", async () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    try {
      expect(await captureBaselineSha(plain)).toBeUndefined();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("returns undefined change set when nothing changed since baseline", async () => {
    const base = await captureBaselineSha(dir);
    expect(await captureChangeSet(dir, base)).toBeUndefined();
  });

  it("captures an uncommitted edit since the baseline", async () => {
    const base = await captureBaselineSha(dir);
    writeFileSync(join(dir, "index.html"), "<h1>a real dog</h1>\n");
    const cs = await captureChangeSet(dir, base);
    expect(cs).toBeDefined();
    expect(cs?.changedFiles).toContain("index.html");
    expect(cs?.diff).toContain("a real dog");
    expect(cs?.diffStat).toMatch(/\d+ files? changed/);
  });

  it("captures a committed change since the baseline", async () => {
    const base = await captureBaselineSha(dir);
    writeFileSync(join(dir, "style.css"), "body{background:#111}\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "dark mode"]);
    const cs = await captureChangeSet(dir, base);
    expect(cs).toBeDefined();
    expect(cs?.changedFiles).toContain("style.css");
    expect(cs?.diff).toContain("background:#111");
  });

  it("captures a brand-new file the agent wrote (via tool path), with synthesized diff", async () => {
    const base = await captureBaselineSha(dir);
    // A new untracked file is in the change set only because the agent wrote it
    // (tool path) — not because it merely exists on disk. This is what keeps a
    // shared workspace's accumulated untracked clutter out of the change set.
    writeFileSync(join(dir, "about.html"), "<p>about</p>\n");
    const cs = await captureChangeSet(dir, base, ["about.html"]);
    expect(cs).toBeDefined();
    expect(cs?.changedFiles).toContain("about.html");
    // new-file content is synthesized via `git diff --no-index`
    expect(cs?.diff).toContain("about");
  });

  it("does NOT capture accumulated untracked clutter the agent never wrote", async () => {
    const base = await captureBaselineSha(dir);
    // Stray files left in a shared workspace by earlier sessions — no tool path.
    writeFileSync(join(dir, "leftover.pdf"), "%PDF-1.4\n");
    writeFileSync(join(dir, "scratch.py"), "print(1)\n");
    // Only the file the agent actually edited this session is a change.
    writeFileSync(join(dir, "index.html"), "<h1>edited</h1>\n");
    const cs = await captureChangeSet(dir, base);
    expect(cs).toBeDefined();
    expect(cs?.changedFiles).toContain("index.html");
    expect(cs?.changedFiles).not.toContain("leftover.pdf");
    expect(cs?.changedFiles).not.toContain("scratch.py");
  });

  it("honors .gitignore: ignored install output is excluded; an agent-written ignored deploy file is included via tool paths", async () => {
    writeFileSync(
      join(dir, ".gitignore"),
      ".venv/\nnode_modules/\ndata/apps/\n",
    );
    git(dir, ["add", ".gitignore"]);
    git(dir, ["commit", "-q", "-m", "gitignore"]);
    const base = await captureBaselineSha(dir);
    // Install output the agent never touched (gitignored) — must NOT appear.
    execFileSync("mkdir", ["-p", join(dir, ".venv", "bin")]);
    writeFileSync(join(dir, ".venv", "bin", "python"), "#!fake\n");
    // A real tracked source edit.
    writeFileSync(join(dir, "index.html"), "<h1>real</h1>\n");
    // A gitignored DEPLOY file the agent wrote — surfaced only via tool paths.
    execFileSync("mkdir", ["-p", join(dir, "data", "apps", "site")]);
    writeFileSync(
      join(dir, "data", "apps", "site", "index.html"),
      "<h1>deploy</h1>\n",
    );
    const cs = await captureChangeSet(dir, base, ["data/apps/site/index.html"]);
    expect(cs).toBeDefined();
    expect(cs?.changedFiles).toContain("index.html");
    expect(cs?.changedFiles).toContain("data/apps/site/index.html");
    expect(cs?.changedFiles.some((f) => f.includes(".venv"))).toBe(false);
  });

  it("relativizes absolute tool-call paths against the workdir", async () => {
    const base = await captureBaselineSha(dir);
    writeFileSync(join(dir, ".gitignore"), "out/\n");
    execFileSync("mkdir", ["-p", join(dir, "out")]);
    writeFileSync(join(dir, "out", "app.js"), "console.log(1)\n");
    const cs = await captureChangeSet(dir, base, [join(dir, "out", "app.js")]);
    expect(cs?.changedFiles).toContain("out/app.js");
  });

  it("rejects relative tool-call paths that escape the workdir after normalization", async () => {
    const base = await captureBaselineSha(dir);
    const cs = await captureChangeSet(dir, base, [
      "subdir/../../outside.txt",
    ]);
    expect(cs).toBeUndefined();
  });

  it("detects a tracked file DELETED since the baseline", async () => {
    writeFileSync(join(dir, "old.html"), "<p>doomed</p>\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "add old"]);
    const base = await captureBaselineSha(dir);
    execFileSync("rm", [join(dir, "old.html")]);
    writeFileSync(join(dir, "index.html"), "<h1>kept</h1>\n");
    const cs = await captureChangeSet(dir, base);
    expect(cs).toBeDefined();
    expect(cs?.changedFiles).toContain("old.html"); // the deletion
    expect(cs?.changedFiles).toContain("index.html"); // the edit
  });

  it("excludes files already dirty at spawn (pre-existing churn the agent didn't touch)", async () => {
    // A tracked file is dirty BEFORE the session starts (e.g. a leftover edit
    // or dirty submodule pointer) — like omnivoice.cpp in the live incident.
    writeFileSync(join(dir, "index.html"), "<h1>pre-existing dirty</h1>\n");
    const base = await captureBaselineSha(dir);
    const baselineDirty = await captureBaselineDirty(dir);
    expect(baselineDirty).toContain("index.html");
    // This session writes a different file.
    writeFileSync(join(dir, "new.html"), "<p>session work</p>\n");
    const cs = await captureChangeSet(dir, base, ["new.html"], baselineDirty);
    expect(cs).toBeDefined();
    expect(cs?.changedFiles).toContain("new.html");
    expect(cs?.changedFiles).not.toContain("index.html"); // pre-existing dirty
  });

  it("keeps a pre-existing-dirty file if the agent DID write it this session", async () => {
    writeFileSync(join(dir, "index.html"), "<h1>dirty before</h1>\n");
    const base = await captureBaselineSha(dir);
    const baselineDirty = await captureBaselineDirty(dir);
    // Agent explicitly edits the already-dirty file this session (tool path).
    writeFileSync(join(dir, "index.html"), "<h1>agent edited it</h1>\n");
    const cs = await captureChangeSet(dir, base, ["index.html"], baselineDirty);
    expect(cs?.changedFiles).toContain("index.html");
  });

  it("summarizes a change set into a one-line banner", () => {
    const text = summarizeChangeSet({
      changedFiles: ["index.html", "style.css"],
      diffStat: "2 files changed",
      diff: "",
      truncated: false,
      capturedAt: 0,
    });
    expect(text).toBe("Changed 2 files: index.html, style.css");
  });
});
