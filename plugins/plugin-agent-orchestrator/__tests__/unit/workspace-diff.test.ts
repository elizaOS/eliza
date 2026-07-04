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
  summarizeChangeSet,
  verifyChangedFilesOnDisk,
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

  it("captures tool-written files outside a git work tree", async () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    try {
      writeFileSync(join(plain, "deploy.txt"), "deployed\n");
      const cs = await captureChangeSet(plain, undefined, ["deploy.txt"]);
      expect(cs).toBeDefined();
      expect(cs?.changedFiles).toEqual(["deploy.txt"]);
      expect(cs?.diffStat).toBe("1 file(s) changed");
      expect(cs?.diff).toContain("deployed");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("rejects escaping tool paths outside a non-git work tree", async () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    try {
      const cs = await captureChangeSet(plain, undefined, [
        "subdir/../../outside.txt",
      ]);
      expect(cs).toBeUndefined();
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
    const cs = await captureChangeSet(dir, base, ["subdir/../../outside.txt"]);
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
    expect(cs?.diffStat).toBe("1 file(s) changed");
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

  it("verifies changed files against the real workdir on disk", () => {
    writeFileSync(join(dir, "verified.txt"), "present\n");
    const verification = verifyChangedFilesOnDisk(dir, [
      "verified.txt",
      "missing.txt",
    ]);
    expect(verification.workdir).toBe(dir);
    expect(verification.verified).toBe(false);
    expect(verification.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "verified.txt", exists: true }),
        expect.objectContaining({ path: "missing.txt", exists: false }),
      ]),
    );
    expect(verification.missingFiles).toEqual(["missing.txt"]);
    expect(
      summarizeChangeSet(
        {
          changedFiles: ["verified.txt", "missing.txt"],
          diffStat: "2 file(s) changed",
          diff: "",
          truncated: false,
          capturedAt: 0,
        },
        verification,
      ),
    ).toContain("UNVERIFIED: missing missing.txt");
  });
});

// FIX C (issue elizaOS/eliza#11578): a fresh repo with zero commits has an
// UNBORN HEAD, so `git diff HEAD` throws and the caller fell back to the weak
// narration path (rounds 1/2 never produced a change set). Diffing against the
// empty-tree hash surfaces the whole working tree; untracked files (shell
// writes) are also merged so scaffolding shows up without tool-path tracking.
describe("workspace-diff — unborn HEAD + untracked (#11578)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsdiff-unborn-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@t.t"]);
    git(dir, ["config", "user.name", "t"]);
    // NO initial commit — HEAD is unborn.
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a change set on an unborn HEAD for a shell-written file", async () => {
    writeFileSync(join(dir, "app.js"), "console.log('hi');\n");
    const cs = await captureChangeSet(dir);
    expect(cs).toBeDefined();
    expect(cs?.changedFiles).toContain("app.js");
  });

  it("includes several untracked files scaffolded on an unborn HEAD", async () => {
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>\n");
    writeFileSync(join(dir, "style.css"), "body{}\n");
    writeFileSync(join(dir, "app.js"), "console.log(1);\n");
    const cs = await captureChangeSet(dir);
    expect(cs).toBeDefined();
    expect(cs?.changedFiles).toEqual(
      expect.arrayContaining(["index.html", "style.css", "app.js"]),
    );
  });

  it("does NOT auto-scoop untracked clutter once HEAD is born (invariant preserved)", async () => {
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "seed"]);
    // HEAD is now born. A stray untracked file with NO tool path must NOT be
    // scooped up — the born-HEAD path stays session-scoped (tracked + toolPaths).
    writeFileSync(join(dir, "stray.txt"), "clutter\n");
    const cs = await captureChangeSet(dir);
    expect(cs).toBeUndefined();
    // But a tool-path-tracked write on born HEAD still surfaces.
    const cs2 = await captureChangeSet(dir, undefined, ["stray.txt"]);
    expect(cs2?.changedFiles).toContain("stray.txt");
  });

  it("returns undefined on an unborn HEAD with no files", async () => {
    const cs = await captureChangeSet(dir);
    expect(cs).toBeUndefined();
  });
});

// The unborn-HEAD untracked scoop (37813124bf, #11605) could flood the
// MAX_CHANGED_FILES cap and evict the agent's real files:
// 1. a fresh scaffold that runs `npm install` BEFORE writing .gitignore has
//    thousands of untracked node_modules paths (`--exclude-standard` has no
//    .gitignore to honor yet), all of which entered the scoop;
// 2. agent-written tool paths were spread LAST into the changed-files union,
//    and Set dedupe keeps first-occurrence order, so the flood evicted them.
describe("workspace-diff — unborn-HEAD scoop flood (#11605)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsdiff-flood-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@t.t"]);
    git(dir, ["config", "user.name", "t"]);
    // NO initial commit — HEAD is unborn. NO .gitignore — install ran first.
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("filters vendor install output that predates any .gitignore", async () => {
    // Shell-scaffolded app (no tool paths at all) + `npm install` output.
    writeFileSync(join(dir, "index.html"), "<h1>app</h1>\n");
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, "server.js"), "require('http');\n");
    for (let i = 0; i < 120; i++) {
      const pkg = join(
        dir,
        "node_modules",
        `pkg-${String(i).padStart(3, "0")}`,
      );
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "index.js"), "module.exports={};\n");
    }
    const cs = await captureChangeSet(dir);
    expect(cs).toBeDefined();
    // ls-files sorts node_modules/* between index.html and package.json —
    // without the vendor filter the cap kept index.html + 59 node_modules
    // paths and evicted package.json and server.js entirely.
    expect(cs?.changedFiles).toContain("index.html");
    expect(cs?.changedFiles).toContain("package.json");
    expect(cs?.changedFiles).toContain("server.js");
    expect(cs?.changedFiles.some((f) => f.startsWith("node_modules/"))).toBe(
      false,
    );
  });

  it("agent-written files survive the cap ahead of a large scaffold", async () => {
    // More legit untracked files than MAX_CHANGED_FILES, all sorting before
    // the agent's tool-written file.
    for (let i = 0; i < 70; i++) {
      writeFileSync(
        join(dir, `page-${String(i).padStart(2, "0")}.html`),
        "<p></p>\n",
      );
    }
    writeFileSync(join(dir, "zzz-server.js"), "require('http');\n");
    const cs = await captureChangeSet(dir, undefined, ["zzz-server.js"]);
    expect(cs).toBeDefined();
    // agentWritten-first: the explicit tool write leads the list and cannot
    // be evicted by the cap (previously it sat at position 71 and was cut).
    expect(cs?.changedFiles[0]).toBe("zzz-server.js");
    expect(cs?.changedFiles.length).toBeLessThanOrEqual(60);
    expect(cs?.truncated).toBe(true);
  });

  it("parseLsFiles drops the truncated garbage tail of an over-maxBuffer listing", () => {
    // A complete `git ls-files` listing always ends with a newline; output cut
    // at maxBuffer (ENOBUFS) ends mid-path instead.
    expect(parseLsFiles("a.txt\nb.txt\nnode_mod")).toEqual(["a.txt", "b.txt"]);
    expect(parseLsFiles("a.txt\nb.txt\n")).toEqual(["a.txt", "b.txt"]);
    expect(parseLsFiles("partial-only-no-newline")).toEqual([]);
    expect(parseLsFiles(undefined)).toEqual([]);
  });
});
