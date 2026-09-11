/**
 * Unit tests for layered .env resolution: pure parse/merge/upsert primitives,
 * real-filesystem load/save against temp dirs (mode 600 asserted), a linked
 * worktree fixture, and the #14793 writer residuals — duplicate-key collapse,
 * trailing-blank preservation, serialized separate-process writes, atomic
 * tmp cleanup, permission repair, and live lock-owner integrity.
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
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyLayeredEnvToProcess,
  atomicWriteEnvFile,
  listPresent,
  loadLayeredEnv,
  mergeEnvLayers,
  parseDotenv,
  reclaimObservedLock,
  saveEnvVar,
  upsertEnvContent,
  writeSecret,
} from "./env-layers.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

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

function writeLockDirectory(lockPath, pid, token) {
  const record = `${pid}:${token}\n`;
  const ownerPath = join(lockPath, `owner-${token}`);
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(ownerPath, record, { mode: 0o600 });
  return { ownerPath, record };
}

function readLockDirectory(lockPath) {
  const entries = readdirSync(lockPath);
  assert.equal(entries.length, 1, "lock directory must contain one owner");
  assert.match(entries[0], /^owner-[a-f0-9]{32}$/);
  const ownerPath = join(lockPath, entries[0]);
  return {
    ownerPath,
    record: readFileSync(ownerPath, "utf8"),
  };
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
  for (const relativePath of importers) {
    const text = readFileSync(join(ROOT, relativePath), "utf8");
    assert.match(
      text,
      /from "\.\/env-layers\.mjs"/,
      `${relativePath} must import scripts/lifeops/env-layers.mjs`,
    );
  }
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

test("writeSecret recovers from a stale sibling lock directory", () => {
  const base = tempDir("env-layers-stale-lock-");
  try {
    const homeEnvPath = join(base, ".eliza", ".env");
    mkdirSync(dirname(homeEnvPath), { recursive: true });
    const lockPath = `${homeEnvPath}.lock`;
    const deadOwner = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(deadOwner.status, 0);
    const deadLock = writeLockDirectory(
      lockPath,
      deadOwner.pid,
      "d".repeat(32),
    );
    const stale = new Date(Date.now() - 30_000);
    utimesSync(deadLock.ownerPath, stale, stale);
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

function writeSecretInChild(
  repoRoot,
  key,
  value,
  afterReadWaitPath,
  options = {},
) {
  const moduleUrl = pathToFileURL(
    join(ROOT, "scripts/lifeops/env-layers.mjs"),
  ).href;
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { writeSecret } from ${JSON.stringify(moduleUrl)};
    const waitPath = ${JSON.stringify(afterReadWaitPath ?? "")};
    const readyPath = ${JSON.stringify(options.readyPath ?? "")};
    writeSecret(${JSON.stringify(key)}, ${JSON.stringify(value)}, {
      scope: "repo",
      repoRoot: ${JSON.stringify(repoRoot)},
      processEnv: {},
      ...(${JSON.stringify(options.lockWaitMs ?? null)} === null
        ? {}
        : { lockWaitMs: ${JSON.stringify(options.lockWaitMs ?? null)} }),
      afterRead: waitPath
        ? () => {
            if (readyPath) {
              writeFileSync(readyPath, "ready\\n");
            }
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
        resolvePromise({ code, stderr });
        return;
      }
      if (options.allowFailure) {
        resolvePromise({ code, stderr });
        return;
      }
      reject(new Error(`child write ${key} exited ${code}: ${stderr}`));
    });
  });
}

function reclaimLockInChild(lockPath, observedRecord, readyPath, waitPath) {
  const moduleUrl = pathToFileURL(
    join(ROOT, "scripts/lifeops/env-layers.mjs"),
  ).href;
  const token = observedRecord.split(":")[1].trim();
  const script = `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { reclaimObservedLock } from ${JSON.stringify(moduleUrl)};
    const lockPath = ${JSON.stringify(lockPath)};
    const observedRecord = ${JSON.stringify(observedRecord)};
    const markerPath = join(lockPath, ${JSON.stringify(`owner-${token}`)});
    if (readFileSync(markerPath, "utf8") !== observedRecord) {
      throw new Error("reclaimer did not observe seeded dead owner");
    }
    writeFileSync(${JSON.stringify(readyPath)}, "ready\\n");
    const deadline = Date.now() + 8000;
    while (!existsSync(${JSON.stringify(waitPath)}) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    process.stdout.write(JSON.stringify({
      reclaimed: reclaimObservedLock(lockPath, observedRecord),
    }));
  `;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      script,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`reclaimer exited ${code}: ${stderr}`));
        return;
      }
      resolvePromise(JSON.parse(stdout));
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

test("an aged live writer keeps lock ownership until its transaction finishes", async () => {
  const base = tempDir("env-layers-live-lock-");
  try {
    const lockPath = `${join(base, ".env")}.lock`;
    const waitPath = join(base, "release-first-writer");
    const first = writeSecretInChild(base, "KEY_A", "aaa", waitPath);
    const started = Date.now();
    while (Date.now() - started < 2000 && !existsSync(lockPath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.equal(
      existsSync(lockPath),
      true,
      "first writer must acquire the lock",
    );
    const firstOwner = readLockDirectory(lockPath);
    const stale = new Date(Date.now() - 30_000);
    utimesSync(firstOwner.ownerPath, stale, stale);

    const second = writeSecretInChild(base, "KEY_B", "bbb");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    assert.equal(
      existsSync(lockPath),
      true,
      "live owner lock must remain present",
    );
    assert.equal(readFileSync(firstOwner.ownerPath, "utf8"), firstOwner.record);

    writeFileSync(waitPath, "go\n");
    await Promise.all([first, second]);
    const parsed = parseDotenv(readFileSync(join(base, ".env"), "utf8"));
    assert.equal(parsed.KEY_A, "aaa");
    assert.equal(parsed.KEY_B, "bbb");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeSecret fails fast when a live owner holds the lock past the wait", async () => {
  const base = tempDir("env-layers-lock-timeout-");
  try {
    const lockPath = `${join(base, ".env")}.lock`;
    mkdirSync(base, { recursive: true });
    // This test process is the live lock owner and never releases.
    const liveLock = writeLockDirectory(lockPath, process.pid, "a".repeat(32));
    const blocked = await writeSecretInChild(base, "TOKEN", "secret", null, {
      lockWaitMs: 300,
      allowFailure: true,
    });
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /timed out waiting for lock/);
    // Fail-fast means no unserialized write happened behind the owner.
    assert.equal(existsSync(join(base, ".env")), false);
    assert.equal(readFileSync(liveLock.ownerPath, "utf8"), liveLock.record);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 20_000);

test("a writer without its owner marker cannot commit", async () => {
  const base = tempDir("env-layers-owned-lock-");
  try {
    const lockPath = `${join(base, ".env")}.lock`;
    const waitPath = join(base, "release-writer");
    const readyPath = join(base, "writer-ready");
    const writer = writeSecretInChild(base, "TOKEN", "secret", waitPath, {
      allowFailure: true,
      readyPath,
    });
    const deadline = Date.now() + 5000;
    while (!existsSync(readyPath) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.equal(existsSync(readyPath), true, "writer must pause after read");

    const displaced = readLockDirectory(lockPath);
    unlinkSync(displaced.ownerPath);
    rmdirSync(lockPath);
    const replacement = writeLockDirectory(
      lockPath,
      process.pid,
      "f".repeat(32),
    );
    writeFileSync(waitPath, "go\n");
    const result = await writer;

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /lock ownership lost before commit/);
    assert.equal(existsSync(join(base, ".env")), false);
    assert.equal(
      readFileSync(replacement.ownerPath, "utf8"),
      replacement.record,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 20_000);

test("an external hand-edit between writes is adopted as the base", () => {
  const base = tempDir("env-layers-external-edit-");
  try {
    const envPath = join(base, ".env");
    writeSecret("FIRST", "one", {
      scope: "repo",
      repoRoot: base,
      processEnv: {},
    });
    // Operator hand-edits the file between two saves.
    writeFileSync(envPath, `${readFileSync(envPath, "utf8")}HAND=edit\n`);
    writeSecret("SECOND", "two", {
      scope: "repo",
      repoRoot: base,
      processEnv: {},
    });
    const parsed = parseDotenv(readFileSync(envPath, "utf8"));
    assert.equal(parsed.FIRST, "one");
    assert.equal(parsed.HAND, "edit");
    assert.equal(parsed.SECOND, "two");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a reclaim stampede over a dead owner admits exactly one writer at a time", async () => {
  const base = tempDir("env-layers-reclaim-stampede-");
  try {
    // A definitely-dead owner: spawn a child that exits, reuse its pid.
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolvePromise) => dead.once("close", resolvePromise));
    const lockPath = `${join(base, ".env")}.lock`;
    mkdirSync(base, { recursive: true });
    writeLockDirectory(lockPath, dead.pid, "b".repeat(32));

    // Several worktrees notice the same dead lock at once (the recovery
    // stampede): token-marker reclamation lets exactly one remove it, and
    // every distinct update must survive.
    await Promise.all([
      writeSecretInChild(base, "KEY_ONE", "one"),
      writeSecretInChild(base, "KEY_TWO", "two"),
      writeSecretInChild(base, "KEY_THREE", "three"),
    ]);
    const parsed = parseDotenv(readFileSync(join(base, ".env"), "utf8"));
    assert.equal(parsed.KEY_ONE, "one");
    assert.equal(parsed.KEY_TWO, "two");
    assert.equal(parsed.KEY_THREE, "three");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 20_000);

test("a stale observer cannot remove a newly live lock directory", () => {
  const base = tempDir("env-layers-stale-observer-");
  try {
    const lockPath = `${join(base, ".env")}.lock`;
    mkdirSync(base, { recursive: true });
    const deadRecord = `999999999:${"c".repeat(32)}\n`;
    const liveLock = writeLockDirectory(lockPath, process.pid, "d".repeat(32));
    // A stale observer targets only deadRecord's immutable token marker. It
    // cannot rename the shared path or remove the replacement directory.
    assert.equal(reclaimObservedLock(lockPath, deadRecord), false);
    assert.equal(readFileSync(liveLock.ownerPath, "utf8"), liveLock.record);

    // Idempotence: reclaiming an already-gone lock is a win, not an error.
    rmSync(lockPath, { recursive: true });
    assert.equal(reclaimObservedLock(lockPath, deadRecord), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("three-process stale observation cannot admit a concurrent writer", async () => {
  const base = tempDir("env-layers-stale-three-process-");
  try {
    const lockPath = `${join(base, ".env")}.lock`;
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolvePromise) => dead.once("close", resolvePromise));
    const deadLock = writeLockDirectory(lockPath, dead.pid, "e".repeat(32));
    const readyR = join(base, "ready-r");
    const goR = join(base, "go-r");
    const reclaimer = reclaimLockInChild(
      lockPath,
      deadLock.record,
      readyR,
      goR,
    );
    const rDeadline = Date.now() + 5000;
    while (!existsSync(readyR) && Date.now() < rDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.equal(existsSync(readyR), true, "R must observe the dead owner");

    const goB = join(base, "go-b");
    const readyB = join(base, "ready-b");
    const writerB = writeSecretInChild(base, "KEY_B", "bbb", goB, {
      readyPath: readyB,
    });
    const bDeadline = Date.now() + 5000;
    while (!existsSync(readyB) && Date.now() < bDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.equal(existsSync(readyB), true, "B must own the replacement lock");
    const ownerB = readLockDirectory(lockPath);

    writeFileSync(goR, "go\n");
    assert.deepEqual(await reclaimer, { reclaimed: false });
    assert.equal(readFileSync(ownerB.ownerPath, "utf8"), ownerB.record);

    const goC = join(base, "go-c");
    const readyC = join(base, "ready-c");
    const writerC = writeSecretInChild(base, "KEY_C", "ccc", goC, {
      readyPath: readyC,
    });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    assert.equal(
      existsSync(readyC),
      false,
      "C must not enter while B owns the replacement lock",
    );

    writeFileSync(goB, "go\n");
    await writerB;
    const cDeadline = Date.now() + 5000;
    while (!existsSync(readyC) && Date.now() < cDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.equal(existsSync(readyC), true, "C must enter after B releases");
    writeFileSync(goC, "go\n");
    await writerC;

    const parsed = parseDotenv(readFileSync(join(base, ".env"), "utf8"));
    assert.equal(parsed.KEY_B, "bbb");
    assert.equal(parsed.KEY_C, "ccc");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

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
