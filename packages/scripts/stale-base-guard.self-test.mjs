#!/usr/bin/env node
/**
 * Self-test for stale-base-guard.mjs (#11376). Builds throwaway fixture repos
 * in a temp dir and asserts the guard's verdicts on every behavior class:
 * clean edits, the #11271 stale-tree clobber shape, heal/re-land PRs,
 * deletion-only PRs, additions, staleness backstops, window bounding, and the
 * `stale-base-ack` override. Runs in CI before the guard itself.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./stale-base-guard.mjs", import.meta.url),
);
const roots = [];
let hourCounter = 0;

function sh(cwd, cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`,
    );
  }
  return res.stdout.trim();
}

function git(dir, args, env) {
  return sh(dir, "git", args, env);
}

function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), "stale-base-guard-fixture-"));
  roots.push(dir);
  git(dir, ["init", "-q", "-b", "develop"]);
  git(dir, ["config", "user.email", "guard-selftest@example.invalid"]);
  git(dir, ["config", "user.name", "stale-base-guard self-test"]);
  return dir;
}

/** Commit file writes (string) and deletions (null), with a deterministic clock. */
function commit(dir, files, message, { hoursFromEpoch } = {}) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      git(dir, ["rm", "-q", path]);
    } else {
      sh(dir, "node", [
        "-e",
        "require('fs').writeFileSync(process.argv[1], process.argv[2])",
        path,
        content,
      ]);
      git(dir, ["add", path]);
    }
  }
  hourCounter = hoursFromEpoch ?? hourCounter + 1;
  const date = new Date(Date.UTC(2026, 0, 1, hourCounter)).toISOString();
  git(dir, ["commit", "-q", "--allow-empty", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(dir, ["rev-parse", "HEAD"]);
}

function runGuard(dir, { base, head, extra = [] }) {
  const json = join(dir, "guard-result.json");
  const res = spawnSync(
    process.execPath,
    [
      script,
      "--repo",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--json",
      json,
      ...extra,
    ],
    { encoding: "utf8" },
  );
  if (res.status === 2 || res.error) {
    throw new Error(`guard errored: ${res.stderr || res.stdout}`);
  }
  return { status: res.status, result: JSON.parse(readFileSync(json, "utf8")) };
}

const findingPaths = (result) =>
  result.revertFindings.map((f) => f.path).sort();
const noticePaths = (result) =>
  result.deletionNotices.map((f) => f.path).sort();

/**
 * The shared fixture mirrors the #11271 shape:
 *   c0: a,b,d,new-era files at v0
 *   c1: a -> alpha-1
 *   c2: b -> beta-1, adds new.txt
 *   c3: a -> alpha-2            <- develop tip (fresh base for the PR)
 */
function baseFixture() {
  const dir = mkRepo();
  const c0 = commit(
    dir,
    { "a.txt": "alpha-0", "b.txt": "beta-0", "d.txt": "delta-0" },
    "c0",
  );
  const c1 = commit(dir, { "a.txt": "alpha-1" }, "c1");
  const c2 = commit(dir, { "b.txt": "beta-1", "new.txt": "nu-0" }, "c2");
  const c3 = commit(dir, { "a.txt": "alpha-2" }, "c3");
  return { dir, c0, c1, c2, c3 };
}

function branchFrom(dir, name, start) {
  git(dir, ["checkout", "-q", "-b", name, start]);
}

// --- 1. Clean edit on a fresh base passes -----------------------------------
{
  const { dir, c3 } = baseFixture();
  branchFrom(dir, "pr", c3);
  commit(dir, { "a.txt": "alpha-3-novel" }, "pr: novel edit");
  const { status, result } = runGuard(dir, { base: c3, head: "pr" });
  assert.equal(status, 0, "clean edit must pass");
  assert.equal(result.verdict, "pass");
  assert.equal(result.staleness.behindCommits, 0);
  console.log("ok 1 - clean edit on fresh base passes");
}

// --- 2. Stale-tree clobber on a fresh base fails (the #11271 shape) ---------
{
  const { dir, c3 } = baseFixture();
  branchFrom(dir, "pr", c3);
  commit(
    dir,
    {
      "a.txt": "alpha-1", // byte-identical revert past c3
      "b.txt": "beta-0", // byte-identical revert past c2
      "new.txt": null, // deletes the file c2 added
      "c-new.txt": "gamma-0", // addition — never flagged
      "d.txt": "delta-1", // novel edit — never flagged
    },
    "pr: stale checkout committed over merged work",
  );
  const { status, result } = runGuard(dir, { base: c3, head: "pr" });
  assert.equal(status, 1, "stale-tree clobber must fail");
  assert.equal(result.verdict, "fail");
  assert.equal(
    result.staleness.failed,
    false,
    "merge-base is fresh; content check must catch it",
  );
  assert.deepEqual(findingPaths(result), ["a.txt", "b.txt", "new.txt"]);
  const byPath = Object.fromEntries(
    result.revertFindings.map((f) => [f.path, f]),
  );
  assert.equal(byPath["a.txt"].discards[0].subject, "c3");
  assert.equal(byPath["b.txt"].discards[0].subject, "c2");
  assert.equal(byPath["new.txt"].discards[0].subject, "c2");
  // With --ack the same PR is loudly allowed.
  const acked = runGuard(dir, { base: c3, head: "pr", extra: ["--ack"] });
  assert.equal(acked.status, 0, "stale-base-ack must override");
  assert.equal(acked.result.verdict, "acked");
  console.log(
    "ok 2 - stale-tree clobber fails; stale-base-ack overrides loudly",
  );
}

// --- 3. Heal PR (re-land clobbered work) passes ------------------------------
{
  const { dir } = baseFixture();
  const c4 = commit(
    dir,
    { "a.txt": "alpha-1" },
    "c4: clobber lands on develop",
  );
  branchFrom(dir, "pr", c4);
  commit(dir, { "a.txt": "alpha-2" }, "pr: re-land the clobbered work");
  const { status, result } = runGuard(dir, { base: c4, head: "pr" });
  assert.equal(
    status,
    0,
    `heal PR must pass: ${JSON.stringify(result.revertFindings)}`,
  );
  assert.equal(result.verdict, "pass");
  console.log("ok 3 - heal PR (restore past a clobber) passes");
}

// --- 4. Deletion-only PR: non-blocking notice --------------------------------
{
  const { dir, c3 } = baseFixture();
  branchFrom(dir, "pr", c3);
  commit(
    dir,
    { "new.txt": null, "d.txt": "delta-rework" },
    "pr: deliberate rework deletes young file",
  );
  const { status, result } = runGuard(dir, { base: c3, head: "pr" });
  assert.equal(status, 0, "deletion-only PR must not block");
  assert.equal(result.verdict, "pass");
  assert.deepEqual(findingPaths(result), []);
  assert.deepEqual(noticePaths(result), ["new.txt"]);
  console.log("ok 4 - deletion-only PR passes with a notice");
}

// --- 5. Re-adding a previously deleted file passes (additions skipped) -------
{
  const dir = mkRepo();
  commit(dir, { "z.txt": "zeta-0" }, "add z");
  const tip = commit(dir, { "z.txt": null }, "delete z");
  branchFrom(dir, "pr", tip);
  commit(dir, { "z.txt": "zeta-0" }, "pr: resurrect z byte-identically");
  const { status, result } = runGuard(dir, { base: tip, head: "pr" });
  assert.equal(status, 0, "re-add must pass");
  assert.equal(result.verdict, "pass");
  console.log("ok 5 - byte-identical re-add of a deleted file passes");
}

// --- 6. Staleness backstop: commits behind ----------------------------------
{
  const { dir, c3 } = baseFixture();
  branchFrom(dir, "pr", c3);
  commit(dir, { "p.txt": "pi-0" }, "pr: fine change on stale base");
  git(dir, ["checkout", "-q", "develop"]);
  for (let i = 0; i < 5; i++)
    commit(dir, { "w.txt": `work-${i}` }, `develop moves ${i}`);
  const { status, result } = runGuard(dir, {
    base: "develop",
    head: "pr",
    extra: ["--max-behind-commits", "3"],
  });
  assert.equal(status, 1, "stale base (commits) must fail");
  assert.equal(result.staleness.failed, true);
  assert.equal(result.staleness.behindCommits, 5);
  assert.deepEqual(findingPaths(result), []);
  const acked = runGuard(dir, {
    base: "develop",
    head: "pr",
    extra: ["--max-behind-commits", "3", "--ack"],
  });
  assert.equal(acked.status, 0);
  assert.equal(acked.result.verdict, "acked");
  console.log("ok 6 - staleness backstop (commits) fails; ack overrides");
}

// --- 7. Staleness backstop: hours behind -------------------------------------
{
  const { dir, c3 } = baseFixture();
  branchFrom(dir, "pr", c3);
  commit(dir, { "p.txt": "pi-0" }, "pr change");
  git(dir, ["checkout", "-q", "develop"]);
  commit(dir, { "w.txt": "work" }, "develop moves 100h later", {
    hoursFromEpoch: hourCounter + 100,
  });
  const { status, result } = runGuard(dir, {
    base: "develop",
    head: "pr",
    extra: ["--max-behind-hours", "72"],
  });
  assert.equal(status, 1, "stale base (hours) must fail");
  assert.equal(result.staleness.failed, true);
  assert.ok(
    result.staleness.behindHours > 72,
    `behindHours=${result.staleness.behindHours}`,
  );
  console.log("ok 7 - staleness backstop (hours) fails");
}

// --- 8. Window bounds the history walk ---------------------------------------
{
  const { dir, c3 } = baseFixture();
  branchFrom(dir, "pr", c3);
  commit(
    dir,
    { "a.txt": "alpha-1", "b.txt": "beta-0" },
    "pr: stale content, but window only sees c3",
  );
  const { status, result } = runGuard(dir, {
    base: c3,
    head: "pr",
    extra: ["--window", "1"],
  });
  // c3 (a.txt) is inside the 1-commit window; c2 (b.txt) is outside it.
  assert.equal(status, 1);
  assert.deepEqual(findingPaths(result), ["a.txt"]);
  console.log("ok 8 - --window bounds how far back reverts are detected");
}

// --- 9. No merge-base: severe staleness failure ------------------------------
{
  const { dir, c3 } = baseFixture();
  git(dir, ["checkout", "-q", "--orphan", "pr"]);
  commit(dir, { "o.txt": "orphan" }, "unrelated history");
  const { status, result } = runGuard(dir, { base: c3, head: "pr" });
  assert.equal(status, 1, "missing merge-base must fail");
  assert.equal(result.staleness.failed, true);
  assert.match(result.staleness.reason, /no merge-base/);
  const acked = runGuard(dir, { base: c3, head: "pr", extra: ["--ack"] });
  assert.equal(acked.status, 0);
  console.log(
    "ok 9 - missing merge-base fails as severe staleness; ack overrides",
  );
}

for (const dir of roots) rmSync(dir, { recursive: true, force: true });
console.log("stale-base-guard self-test: 9/9 passed");
