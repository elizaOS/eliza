/**
 * Deterministic parser and real child-process CLI boundary tests for the
 * training-harvest runner. No provider, network, or integration service is
 * accessed; the CLI case uses the local deterministic mode only.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as harvestRunner from "./harvest-runner.mjs";

const runner = fileURLToPath(new URL("./harvest-runner.mjs", import.meta.url));
const { parseHarvestLimit } = harvestRunner;

function createDryRunFixture(t) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "eliza harvest resume "));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const binDir = path.join(tempDir, "bin");
  mkdirSync(binDir);
  const fakeBunBody = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("list")) {
  process.stdout.write("completed-A\\nunfinished-B\\n");
} else if (args.includes("run")) {
  const value = (name) => args[args.indexOf(name) + 1];
  const reportPath = value("--report");
  const nativePath = value("--export-native");
  const id = value("--scenario");
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify({ scenarios: [{ id, status: "passed", judgeScore: 1 }] }),
  );
  writeFileSync(nativePath, "{}\\n");
} else {
  process.exitCode = 2;
}
`;
  if (process.platform === "win32") {
    const fakeBunScript = path.join(binDir, "fake-bun.cjs");
    writeFileSync(fakeBunScript, fakeBunBody);
    writeFileSync(
      path.join(binDir, "bun.cmd"),
      `@echo off\r\n"${process.execPath}" "${fakeBunScript}" %*\r\n`,
    );
  } else {
    writeFileSync(path.join(binDir, "bun"), fakeBunBody, { mode: 0o755 });
  }

  const manifestPath = path.join(tempDir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      families: { scenario: { items: [{ dir: "fixture-dir" }] } },
    }),
  );

  const env = {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  for (const key of ["ComSpec", "PATHEXT", "SystemRoot"]) {
    if (process.env[key]) env[key] = process.env[key];
  }

  return {
    env,
    harvestRoot: path.join(tempDir, "harvest"),
    manifestPath,
  };
}

function runFixture(fixture, ...args) {
  return spawnSync(
    process.execPath,
    [
      runner,
      "--deterministic",
      "--manifest",
      fixture.manifestPath,
      "--harvest-root",
      fixture.harvestRoot,
      "--limit",
      "1",
      ...args,
    ],
    { encoding: "utf8", env: fixture.env },
  );
}

test("scenario writes and resume checks share the canonical marker path", {
  timeout: 20_000,
}, (t) => {
  const fixture = createDryRunFixture(t);
  const itemDir = path.join(
    fixture.harvestRoot,
    "scenario",
    "fixture-dir",
    "completed-A",
  );
  const verdictPath = path.join(itemDir, "verdict.json");
  assert.equal(typeof harvestRunner.scenarioItemPath, "function");
  assert.equal(
    harvestRunner.scenarioItemPath(
      fixture.harvestRoot,
      "fixture-dir",
      "completed-A",
      "verdict.json",
    ),
    verdictPath,
  );

  const firstRun = runFixture(fixture);
  assert.equal(firstRun.status, 0, firstRun.stderr);
  assert.equal(existsSync(verdictPath), true);
  const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
  assert.equal(verdict.status, "passed");
  assert.equal(verdict.rows, 1);
  assert.equal(verdict.judgeScore, 1);
  assert.equal(verdict.reportPath, path.join(itemDir, "report.json"));
  assert.equal(verdict.nativePath, path.join(itemDir, "native.jsonl"));

  const resumedRun = runFixture(fixture, "--resume", "--dry-run");
  assert.equal(resumedRun.status, 0, resumedRun.stderr);
  assert.match(
    resumedRun.stdout,
    /\[resume\] skip \(already harvested\) fixture-dir :: completed-A/,
  );
});

test("resume limit budgets unfinished scenarios rather than completed entries", (t) => {
  const fixture = createDryRunFixture(t);
  const completedMarker = path.join(
    fixture.harvestRoot,
    "scenario",
    "fixture-dir",
    "completed-A",
  );
  mkdirSync(completedMarker, { recursive: true });
  writeFileSync(path.join(completedMarker, "verdict.json"), "{}");

  const result = runFixture(fixture, "--resume", "--dry-run");

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /\[resume\] skip \(already harvested\) fixture-dir :: completed-A/,
  );
  assert.match(
    result.stdout,
    /\[dry-run\] would harvest scenario fixture-dir :: unfinished-B/,
  );
  assert.doesNotMatch(
    result.stdout,
    /\[dry-run\] would harvest scenario fixture-dir :: completed-A/,
  );
});

test("limit without resume retains the first-entry execution contract", (t) => {
  const fixture = createDryRunFixture(t);
  const result = runFixture(fixture, "--dry-run");

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /\[dry-run\] would harvest scenario fixture-dir :: completed-A/,
  );
  assert.doesNotMatch(result.stdout, /unfinished-B|\[resume\]/);
});

test("parseHarvestLimit accepts the unlimited sentinel and safe bounds", () => {
  assert.equal(parseHarvestLimit("0"), 0);
  assert.equal(parseHarvestLimit("12"), 12);
  assert.equal(parseHarvestLimit("00012"), 12);
  assert.equal(
    parseHarvestLimit(String(Number.MAX_SAFE_INTEGER)),
    Number.MAX_SAFE_INTEGER,
  );
});

test("parseHarvestLimit rejects values that JavaScript would partially coerce", () => {
  for (const raw of [
    "",
    " ",
    " 12",
    "12 ",
    "-1",
    "+1",
    "1.5",
    "1e2",
    "12junk",
    "Infinity",
    `${String(Number.MAX_SAFE_INTEGER)}0`,
  ]) {
    assert.throws(() => parseHarvestLimit(raw), /--limit must be/);
  }
});

test("invalid --limit fails before deterministic CLI planning", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--deterministic",
      "--family",
      "unsupported",
      "--limit",
      "-1",
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /--limit must be/);
  assert.doesNotMatch(
    result.stdout,
    /providerSource|requires trajectory wiring/,
  );
});
