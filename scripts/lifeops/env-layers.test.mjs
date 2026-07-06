/**
 * Unit tests for layered .env resolution: pure parse/merge/upsert primitives,
 * real-filesystem load/save against temp dirs (mode 600 asserted), and real
 * git worktree discovery against a throwaway repo + linked worktree created in
 * a temp dir — no mocks of git or fs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyLayeredEnvToProcess,
  discoverMainCheckoutRoot,
  listPresent,
  loadLayeredEnv,
  mergeEnvLayers,
  parseDotenv,
  resolveMainCheckoutRoot,
  saveEnvVar,
  upsertEnvContent,
} from "./env-layers.mjs";

// realpath so git-canonicalized paths (macOS /var -> /private/var) compare equal.
function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

// --- parseDotenv --------------------------------------------------------------

test("parseDotenv handles comments, export prefix, quotes, and CRLF", () => {
  const parsed = parseDotenv(
    [
      "# comment",
      "PLAIN=value",
      "export EXPORTED=exported-value",
      'DQ="double quoted"',
      "SQ='single quoted'",
      "SPACED =  padded  ",
      "not a valid line",
      "EMPTY=",
      "1BAD=starts-with-digit",
    ].join("\r\n"),
  );
  assert.deepEqual(parsed, {
    PLAIN: "value",
    EXPORTED: "exported-value",
    DQ: "double quoted",
    SQ: "single quoted",
    SPACED: "padded",
    EMPTY: "",
  });
});

// --- mergeEnvLayers -------------------------------------------------------------

test("mergeEnvLayers: first (highest-precedence) definition wins, sources attributed", () => {
  const { values, sources } = mergeEnvLayers([
    { source: "process", values: { A: "proc", EMPTYWIN: "" } },
    { source: "repo", values: { A: "repo", B: "repo", EMPTYWIN: "file" } },
    { source: "main", values: { B: "main", C: "main" } },
    { source: "home", values: { C: "home", D: "home", SKIPPED: undefined } },
  ]);
  assert.deepEqual(values, {
    A: "proc",
    B: "repo",
    C: "main",
    D: "home",
    EMPTYWIN: "",
  });
  assert.deepEqual(sources, {
    A: "process",
    B: "repo",
    C: "main",
    D: "home",
    EMPTYWIN: "process",
  });
});

// --- upsertEnvContent ------------------------------------------------------------

test("upsertEnvContent replaces in place, preserves comments, appends new keys", () => {
  const before = [
    "# keep me",
    "KEEP=old-keep",
    "REPLACE=old",
    "",
    "export ALSO=old-also",
  ].join("\n");
  const after = upsertEnvContent(before, {
    REPLACE: "new",
    ALSO: "new-also",
    ADDED: "fresh",
  });
  assert.equal(
    after,
    [
      "# keep me",
      "KEEP=old-keep",
      "REPLACE=new",
      "",
      "ALSO=new-also",
      "ADDED=fresh",
      "",
    ].join("\n"),
  );
});

test("upsertEnvContent on empty text emits just the entries", () => {
  assert.equal(upsertEnvContent("", { A: "1" }), "A=1\n");
});

// --- worktree discovery -----------------------------------------------------------

test("resolveMainCheckoutRoot: same git dir means no main layer", () => {
  assert.equal(
    resolveMainCheckoutRoot({
      gitDir: ".git",
      gitCommonDir: ".git",
      worktreeRoot: "/repo",
    }),
    null,
  );
});

test("resolveMainCheckoutRoot: linked worktree resolves to common dir parent", () => {
  assert.equal(
    resolveMainCheckoutRoot({
      gitDir: "/main/.git/worktrees/wt",
      gitCommonDir: "/main/.git",
      worktreeRoot: "/main/.claude/worktrees/wt",
    }),
    "/main",
  );
});

test("discoverMainCheckoutRoot against a real repo + linked worktree", () => {
  const base = tempDir("env-layers-git-");
  try {
    const mainRoot = join(base, "main");
    const wtRoot = join(base, "wt");
    git(base, ["init", "-b", "main", "main"]);
    writeFileSync(join(mainRoot, "seed.txt"), "seed\n");
    git(mainRoot, ["add", "seed.txt"]);
    git(mainRoot, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "seed",
    ]);
    git(mainRoot, ["worktree", "add", wtRoot]);

    assert.equal(discoverMainCheckoutRoot(wtRoot), mainRoot);
    assert.equal(discoverMainCheckoutRoot(mainRoot), null);
    assert.equal(discoverMainCheckoutRoot(base), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- loadLayeredEnv / listPresent ---------------------------------------------------

test("loadLayeredEnv merges process > repo > main > home and reports layers", () => {
  const base = tempDir("env-layers-load-");
  try {
    const repoRoot = join(base, "repo");
    const mainRoot = join(base, "main");
    const homeEnvPath = join(base, "home", ".eliza", ".env");
    for (const dir of [repoRoot, mainRoot, join(base, "home", ".eliza")]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(repoRoot, ".env"), "A=repo\nB=repo\n");
    writeFileSync(join(mainRoot, ".env"), "B=main\nC=main\n");
    writeFileSync(homeEnvPath, "C=home\nD=home\n");
    const { values, sources, layers } = loadLayeredEnv({
      processEnv: { A: "proc" },
      repoRoot,
      mainRoot,
      homeEnvPath,
    });
    assert.equal(values.A, "proc");
    assert.equal(values.B, "repo");
    assert.equal(values.C, "main");
    assert.equal(values.D, "home");
    assert.deepEqual(sources, {
      A: "process",
      B: "repo",
      C: "main",
      D: "home",
    });
    assert.deepEqual(
      layers.map((layer) => [layer.source, layer.exists]),
      [
        ["process", true],
        ["repo", true],
        ["main", true],
        ["home", true],
      ],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadLayeredEnv: absent main layer and missing files are graceful", () => {
  const base = tempDir("env-layers-absent-");
  try {
    const repoRoot = join(base, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const { values, sources, layers } = loadLayeredEnv({
      processEnv: {},
      repoRoot,
      mainRoot: null,
      homeEnvPath: join(base, "nonexistent", ".env"),
    });
    assert.deepEqual(values, {});
    assert.deepEqual(sources, {});
    assert.deepEqual(
      layers.map((layer) => layer.source),
      ["process", "repo", "home"],
    );
    assert.equal(
      layers.every((layer) => layer.source === "process" || !layer.exists),
      true,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadLayeredEnv skips the main layer when it equals the repo root", () => {
  const base = tempDir("env-layers-samepath-");
  try {
    writeFileSync(join(base, ".env"), "A=here\n");
    const { layers } = loadLayeredEnv({
      processEnv: {},
      repoRoot: base,
      mainRoot: base,
      homeEnvPath: join(base, "no-home.env"),
    });
    assert.deepEqual(
      layers.map((layer) => layer.source),
      ["process", "repo", "home"],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("applyLayeredEnvToProcess hydrates only keys the process does not define", () => {
  const base = tempDir("env-layers-apply-");
  try {
    const repoRoot = join(base, "repo");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, ".env"), "FROM_REPO=repo\nKEPT=shadowed\n");
    const homeEnvPath = join(base, "home.env");
    writeFileSync(homeEnvPath, "FROM_HOME=home\nFROM_REPO=home-loses\n");
    const processEnv = { KEPT: "process-wins", EMPTY: "" };
    const loaded = applyLayeredEnvToProcess({
      processEnv,
      repoRoot,
      mainRoot: null,
      homeEnvPath,
    });
    assert.equal(processEnv.FROM_REPO, "repo");
    assert.equal(processEnv.FROM_HOME, "home");
    assert.equal(processEnv.KEPT, "process-wins");
    assert.equal(processEnv.EMPTY, "", "empty-but-defined keys stay untouched");
    assert.equal(loaded.sources.FROM_REPO, "repo");
    assert.equal(loaded.sources.KEPT, "process");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("listPresent attributes each of the four sources and never returns values", () => {
  const base = tempDir("env-layers-present-");
  try {
    const repoRoot = join(base, "repo");
    const mainRoot = join(base, "main");
    const homeEnvPath = join(base, "home.env");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(mainRoot, { recursive: true });
    writeFileSync(join(repoRoot, ".env"), "FROM_REPO=secret-repo\nEMPTYVAL=\n");
    writeFileSync(join(mainRoot, ".env"), "FROM_MAIN=secret-main\n");
    writeFileSync(homeEnvPath, "FROM_HOME=secret-home\n");
    const rows = listPresent(
      [
        "FROM_PROC",
        "FROM_REPO",
        "FROM_MAIN",
        "FROM_HOME",
        "EMPTYVAL",
        "ABSENT",
      ],
      {
        processEnv: { FROM_PROC: "secret-proc" },
        repoRoot,
        mainRoot,
        homeEnvPath,
      },
    );
    assert.deepEqual(rows, [
      { name: "FROM_PROC", present: true, source: "process" },
      { name: "FROM_REPO", present: true, source: "repo" },
      { name: "FROM_MAIN", present: true, source: "main" },
      { name: "FROM_HOME", present: true, source: "home" },
      { name: "EMPTYVAL", present: false, source: "repo" },
      { name: "ABSENT", present: false, source: null },
    ]);
    assert.equal(JSON.stringify(rows).includes("secret-"), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- saveEnvVar -----------------------------------------------------------------------

test("saveEnvVar creates the home file with mode 600 and upserts on re-save", () => {
  const base = tempDir("env-layers-save-");
  try {
    const homeEnvPath = join(base, ".eliza", ".env");
    const processEnv = {};
    const first = saveEnvVar("NEW_TOKEN", "tok-1", "home", {
      homeEnvPath,
      processEnv,
    });
    assert.deepEqual(first, {
      key: "NEW_TOKEN",
      target: "home",
      path: homeEnvPath,
    });
    assert.equal(readFileSync(homeEnvPath, "utf8"), "NEW_TOKEN=tok-1\n");
    assert.equal(statSync(homeEnvPath).mode & 0o777, 0o600);
    assert.equal(processEnv.NEW_TOKEN, "tok-1");

    writeFileSync(homeEnvPath, "# note\nNEW_TOKEN=tok-1\nOTHER=keep\n");
    saveEnvVar("NEW_TOKEN", "tok-2", "home", { homeEnvPath, processEnv });
    assert.equal(
      readFileSync(homeEnvPath, "utf8"),
      "# note\nNEW_TOKEN=tok-2\nOTHER=keep\n",
    );
    assert.equal(statSync(homeEnvPath).mode & 0o777, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("saveEnvVar writes the repo layer when targeted", () => {
  const base = tempDir("env-layers-save-repo-");
  try {
    const processEnv = {};
    const result = saveEnvVar("REPO_ONLY", "x", "repo", {
      repoRoot: base,
      processEnv,
    });
    assert.equal(result.path, join(base, ".env"));
    assert.equal(readFileSync(join(base, ".env"), "utf8"), "REPO_ONLY=x\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("saveEnvVar rejects invalid keys, multi-line values, and bad targets", () => {
  const base = tempDir("env-layers-save-bad-");
  try {
    const options = { homeEnvPath: join(base, ".env"), processEnv: {} };
    assert.throws(
      () => saveEnvVar("bad key", "v", "home", options),
      /invalid env key/,
    );
    assert.throws(
      () => saveEnvVar("GOOD_KEY", "a\nb", "home", options),
      /single-line/,
    );
    assert.throws(
      () => saveEnvVar("GOOD_KEY", "v", "elsewhere", options),
      /target/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
