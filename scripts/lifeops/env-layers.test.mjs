/**
 * Unit tests for layered .env resolution: pure parse/merge/upsert primitives,
 * real-filesystem load/save against temp dirs (mode 600 asserted), a linked
 * worktree fixture, and the #14793 writer residuals — duplicate-key collapse,
 * trailing-blank preservation, serialized separate-process writes, atomic
 * tmp cleanup, and permission repair.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  applyLayeredEnvToProcess,
  atomicWriteEnvFile,
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

test("upsertEnvContent collapses every definition of a written key", () => {
  const after = upsertEnvContent(
    [
      "TOKEN=first",
      "KEEP=ok",
      "export TOKEN=stale-later",
      "TOKEN=also-stale",
    ].join("\n"),
    { TOKEN: "fresh" },
  );
  assert.equal(after, "TOKEN=fresh\nKEEP=ok\n");
  assert.equal(parseDotenv(after).TOKEN, "fresh");
  assert.equal([...after.matchAll(/^TOKEN=/gm)].length, 1);
});

test("upsertEnvContent preserves trailing blank lines on in-place replace", () => {
  const after = upsertEnvContent("KEEP=old\n\n\n", { KEEP: "new" });
  assert.equal(after, "KEEP=new\n\n\n");
  assert.equal(parseDotenv(after).KEEP, "new");
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

test("surviving HITL consumers import the shared layered env module", () => {
  const importers = [
    "scripts/lifeops/hitl-credential-dashboard.mjs",
    "scripts/lifeops/env-layers.test.mjs",
  ];
  let seen = 0;
  for (const relativePath of importers) {
    const fullPath = join(ROOT, relativePath);
    if (!existsSync(fullPath)) continue;
    seen += 1;
    const text = readFileSync(fullPath, "utf8");
    assert.match(
      text,
      /from "\.\/env-layers\.mjs"/,
      `${relativePath} must import scripts/lifeops/env-layers.mjs`,
    );
  }
  assert.ok(
    seen >= 2,
    "at least the dashboard and this test must still import env-layers",
  );
});

test("writeSecret collapses duplicate keys so parseDotenv cannot return a stale later value", () => {
  const base = tempDir("env-layers-dup-key-");
  try {
    const homeEnvPath = join(base, ".eliza", ".env");
    mkdirSync(dirname(homeEnvPath), { recursive: true });
    writeFileSync(
      homeEnvPath,
      "TOKEN=first\nKEEP=ok\nexport TOKEN=stale-later\n",
      "utf8",
    );
    const processEnv = {};
    writeSecret("TOKEN", "fresh", { scope: "home", homeEnvPath, processEnv });
    const text = readFileSync(homeEnvPath, "utf8");
    assert.equal(text, "TOKEN=fresh\nKEEP=ok\n");
    assert.equal(parseDotenv(text).TOKEN, "fresh");
    assert.equal(processEnv.TOKEN, "fresh");
    assert.equal(statSync(homeEnvPath).mode & 0o777, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeSecret preserves trailing blanks and repairs a world-readable mode", () => {
  const base = tempDir("env-layers-blanks-mode-");
  try {
    const homeEnvPath = join(base, ".eliza", ".env");
    mkdirSync(dirname(homeEnvPath), { recursive: true });
    writeFileSync(homeEnvPath, "KEEP=old\n\n\n", {
      encoding: "utf8",
      mode: 0o644,
    });
    writeSecret("KEEP", "new", {
      scope: "home",
      homeEnvPath,
      processEnv: {},
    });
    assert.equal(readFileSync(homeEnvPath, "utf8"), "KEEP=new\n\n\n");
    assert.equal(statSync(homeEnvPath).mode & 0o777, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("atomicWriteEnvFile removes the tmp file when rename cannot replace the target", () => {
  const base = tempDir("env-layers-atomic-fail-");
  try {
    const dest = join(base, "env-as-dir");
    mkdirSync(dest, { recursive: true });
    assert.throws(() => atomicWriteEnvFile(dest, "A=1\n"));
    const leftovers = readdirSync(base).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeSecret recovers from a stale sibling lock file", () => {
  const base = tempDir("env-layers-stale-lock-");
  try {
    const homeEnvPath = join(base, ".eliza", ".env");
    mkdirSync(dirname(homeEnvPath), { recursive: true });
    const lockPath = `${homeEnvPath}.lock`;
    writeFileSync(lockPath, "999999\n", "utf8");
    const stale = new Date(Date.now() - 30_000);
    utimesSync(lockPath, stale, stale);
    writeSecret("RECOVERED", "yes", {
      scope: "home",
      homeEnvPath,
      processEnv: {},
    });
    assert.equal(
      parseDotenv(readFileSync(homeEnvPath, "utf8")).RECOVERED,
      "yes",
    );
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function writeSecretInChild(repoRoot, key, value, afterReadWaitPath) {
  const moduleUrl = pathToFileURL(
    join(ROOT, "scripts/lifeops/env-layers.mjs"),
  ).href;
  const script = `
    import { existsSync } from "node:fs";
    import { writeSecret } from ${JSON.stringify(moduleUrl)};
    const waitPath = ${JSON.stringify(afterReadWaitPath ?? "")};
    writeSecret(${JSON.stringify(key)}, ${JSON.stringify(value)}, {
      scope: "repo",
      repoRoot: ${JSON.stringify(repoRoot)},
      processEnv: {},
      afterRead: waitPath
        ? () => {
            const deadline = Date.now() + 5000;
            while (!existsSync(waitPath) && Date.now() < deadline) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
          }
        : undefined,
    });
  `;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        encoding: "utf8",
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`child write ${key} exited ${code}: ${stderr}`));
    });
  });
}

test("writeSecret serializes separate-process multi-key writes so neither save is lost", async () => {
  const base = tempDir("env-layers-race-");
  try {
    const waitPath = join(base, "release-first-writer");
    const first = writeSecretInChild(base, "KEY_A", "aaa", waitPath);
    const started = Date.now();
    while (
      Date.now() - started < 2000 &&
      !existsSync(`${join(base, ".env")}.lock`)
    ) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const second = writeSecretInChild(base, "KEY_B", "bbb");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    writeFileSync(waitPath, "go\n");
    await Promise.all([first, second]);
    const parsed = parseDotenv(readFileSync(join(base, ".env"), "utf8"));
    assert.equal(parsed.KEY_A, "aaa");
    assert.equal(parsed.KEY_B, "bbb");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeSecret same-key child writers leave exactly one definition", async () => {
  const base = tempDir("env-layers-same-key-race-");
  try {
    await Promise.all([
      writeSecretInChild(base, "TOKEN", "one"),
      writeSecretInChild(base, "TOKEN", "two"),
    ]);
    const text = readFileSync(join(base, ".env"), "utf8");
    const matches = [...text.matchAll(/^TOKEN=/gm)];
    assert.equal(matches.length, 1);
    assert.ok(["one", "two"].includes(parseDotenv(text).TOKEN));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
