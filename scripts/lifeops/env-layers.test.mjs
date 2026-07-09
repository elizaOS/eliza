/**
 * Unit tests for layered .env resolution: pure parse/merge/upsert primitives,
 * real-filesystem load/save against temp dirs (mode 600 asserted), and a real
 * linked-worktree fixture proving an empty worktree .env falls through to the
 * home-scoped layer.
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
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  applyLayeredEnvToProcess,
  listPresent,
  loadLayeredEnv,
  mergeEnvLayers,
  parseDotenv,
  saveEnvVar,
  upsertEnvContent,
  writeSecret,
} from "./env-layers.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);

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
    { source: "home", values: { C: "home", D: "home", SKIPPED: undefined } },
  ]);
  assert.deepEqual(values, {
    A: "proc",
    B: "repo",
    C: "home",
    D: "home",
    EMPTYWIN: "",
  });
  assert.deepEqual(sources, {
    A: "process",
    B: "repo",
    C: "home",
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

// --- loadLayeredEnv / listPresent ---------------------------------------------------

test("loadLayeredEnv merges process > repo > home and reports layers", () => {
  const base = tempDir("env-layers-load-");
  try {
    const repoRoot = join(base, "repo");
    const homeEnvPath = join(base, "home", ".eliza", ".env");
    for (const dir of [repoRoot, join(base, "home", ".eliza")]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(repoRoot, ".env"), "A=repo\nB=repo\n");
    writeFileSync(homeEnvPath, "B=home\nC=home\n");
    const { values, sources, layers } = loadLayeredEnv({
      processEnv: { A: "proc" },
      repoRoot,
      homeEnvPath,
    });
    assert.equal(values.A, "proc");
    assert.equal(values.B, "repo");
    assert.equal(values.C, "home");
    assert.deepEqual(sources, {
      A: "process",
      B: "repo",
      C: "home",
    });
    assert.deepEqual(
      layers.map((layer) => [layer.source, layer.exists]),
      [
        ["process", true],
        ["repo", true],
        ["home", true],
      ],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadLayeredEnv: missing files are graceful", () => {
  const base = tempDir("env-layers-absent-");
  try {
    const repoRoot = join(base, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const { values, sources, layers } = loadLayeredEnv({
      processEnv: {},
      repoRoot,
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

test("fresh linked worktree with empty repo .env uses home-scoped secrets, not main checkout .env", () => {
  const base = tempDir("env-layers-worktree-home-");
  try {
    const mainRoot = join(base, "main");
    const wtRoot = join(base, "wt");
    const homeEnvPath = join(base, "home", ".eliza", ".env");
    git(base, ["init", "-b", "main", "main"]);
    writeFileSync(join(mainRoot, "seed.txt"), "seed\n");
    writeFileSync(join(mainRoot, ".env"), "TOKEN=stale-main\n");
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
    mkdirSync(dirname(homeEnvPath), { recursive: true });
    writeFileSync(homeEnvPath, "TOKEN=home-secret\n");

    const loaded = loadLayeredEnv({
      processEnv: {},
      repoRoot: wtRoot,
      homeEnvPath,
    });
    assert.equal(loaded.values.TOKEN, "home-secret");
    assert.equal(loaded.sources.TOKEN, "home");
    assert.deepEqual(
      loaded.layers.map((layer) => layer.source),
      ["process", "repo", "home"],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("listPresent attributes each source and never returns values", () => {
  const base = tempDir("env-layers-present-");
  try {
    const repoRoot = join(base, "repo");
    const homeEnvPath = join(base, "home.env");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, ".env"), "FROM_REPO=secret-repo\nEMPTYVAL=\n");
    writeFileSync(homeEnvPath, "FROM_HOME=secret-home\n");
    const rows = listPresent(
      ["FROM_PROC", "FROM_REPO", "FROM_HOME", "EMPTYVAL", "ABSENT"],
      {
        processEnv: { FROM_PROC: "secret-proc" },
        repoRoot,
        homeEnvPath,
      },
    );
    assert.deepEqual(rows, [
      { name: "FROM_PROC", present: true, source: "process" },
      { name: "FROM_REPO", present: true, source: "repo" },
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

test("writeSecret creates the home file with mode 600 and upserts on re-save", () => {
  const base = tempDir("env-layers-save-");
  try {
    const homeEnvPath = join(base, ".eliza", ".env");
    const processEnv = {};
    const first = writeSecret("NEW_TOKEN", "tok-1", {
      scope: "home",
      homeEnvPath,
      processEnv,
    });
    assert.deepEqual(first, {
      key: "NEW_TOKEN",
      scope: "home",
      path: homeEnvPath,
    });
    assert.equal(readFileSync(homeEnvPath, "utf8"), "NEW_TOKEN=tok-1\n");
    assert.equal(statSync(homeEnvPath).mode & 0o777, 0o600);
    assert.equal(processEnv.NEW_TOKEN, "tok-1");

    writeFileSync(homeEnvPath, "# note\nNEW_TOKEN=tok-1\nOTHER=keep\n");
    writeSecret("NEW_TOKEN", "tok-2", {
      scope: "home",
      homeEnvPath,
      processEnv,
    });
    assert.equal(
      readFileSync(homeEnvPath, "utf8"),
      "# note\nNEW_TOKEN=tok-2\nOTHER=keep\n",
    );
    assert.equal(statSync(homeEnvPath).mode & 0o777, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeSecret writes the repo layer when scoped", () => {
  const base = tempDir("env-layers-save-repo-");
  try {
    const processEnv = {};
    const result = writeSecret("REPO_ONLY", "x", {
      scope: "repo",
      repoRoot: base,
      processEnv,
    });
    assert.equal(result.path, join(base, ".env"));
    assert.equal(readFileSync(join(base, ".env"), "utf8"), "REPO_ONLY=x\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("saveEnvVar remains a compatibility wrapper for existing dashboard callers", () => {
  const base = tempDir("env-layers-save-wrapper-");
  try {
    const processEnv = {};
    const result = saveEnvVar("WRAPPED", "x", "repo", {
      repoRoot: base,
      processEnv,
    });
    assert.deepEqual(result, {
      key: "WRAPPED",
      target: "repo",
      path: join(base, ".env"),
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeSecret rejects invalid keys, multi-line values, and bad scopes", () => {
  const base = tempDir("env-layers-save-bad-");
  try {
    const options = { homeEnvPath: join(base, ".env"), processEnv: {} };
    assert.throws(
      () => writeSecret("bad key", "v", options),
      /invalid env key/,
    );
    assert.throws(
      () => writeSecret("GOOD_KEY", "a\nb", options),
      /single-line/,
    );
    assert.throws(
      () => writeSecret("GOOD_KEY", "v", { ...options, scope: "elsewhere" }),
      /scope/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("HITL dashboard, lane driver, collector, and tests import the shared layered env module", () => {
  const importers = [
    "scripts/lifeops/hitl-credential-dashboard.mjs",
    "scripts/lifeops/run-11632-live-lanes.mjs",
    "scripts/lifeops/collect-11632-live-validation-status.mjs",
    "scripts/lifeops/env-layers.test.mjs",
  ];
  for (const relativePath of importers) {
    const text = readFileSync(join(ROOT, relativePath), "utf8");
    assert.match(
      text,
      /from "\.\/env-layers\.mjs"/,
      `${relativePath} must import scripts/lifeops/env-layers.mjs`,
    );
  }
});
