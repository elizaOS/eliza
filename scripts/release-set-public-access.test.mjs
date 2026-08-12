import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import tmp from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  main,
  parseArgs,
  printHelp,
  runCli,
} from "./release-set-public-access.mjs";

describe("release-set-public-access CLI option parsing", () => {
  it("defaults to standard configuration", () => {
    const opts = parseArgs([]);
    assert.equal(opts.help, false);
    assert.equal(opts.dryRun, false);
    assert.equal(opts.cohort, null);
    assert.ok(typeof opts.repoRoot === "string" && opts.repoRoot.length > 0);
  });

  it("parses --help and -h flags", () => {
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["-h"]).help, true);
  });

  it("parses --dry-run flag", () => {
    const opts = parseArgs(["--dry-run"]);
    assert.equal(opts.dryRun, true);
  });

  it("parses --repo-root=<dir> and --repo-root <dir>", () => {
    assert.equal(
      parseArgs(["--repo-root=/tmp/test-repo"]).repoRoot,
      path.resolve("/tmp/test-repo"),
    );
    assert.equal(
      parseArgs(["--repo-root", "/tmp/test-repo"]).repoRoot,
      path.resolve("/tmp/test-repo"),
    );
  });

  it("parses --cohort=<file> and --cohort <file>", () => {
    assert.equal(
      parseArgs(["--cohort=/tmp/cohort.json"]).cohort,
      path.resolve("/tmp/cohort.json"),
    );
    assert.equal(
      parseArgs(["--cohort", "/tmp/cohort.json"]).cohort,
      path.resolve("/tmp/cohort.json"),
    );
  });

  it("rejects --repo-root without a value", () => {
    assert.throws(
      () => parseArgs(["--repo-root="]),
      /\[release-manifests\] --repo-root requires a directory path/,
    );
    assert.throws(
      () => parseArgs(["--repo-root"]),
      /\[release-manifests\] --repo-root requires a directory path/,
    );
    assert.throws(
      () => parseArgs(["--repo-root", "--dry-run"]),
      /\[release-manifests\] --repo-root requires a directory path/,
    );
  });

  it("rejects --cohort without a value", () => {
    assert.throws(
      () => parseArgs(["--cohort="]),
      /\[release-manifests\] --cohort requires a file path/,
    );
    assert.throws(
      () => parseArgs(["--cohort"]),
      /\[release-manifests\] --cohort requires a file path/,
    );
    assert.throws(
      () => parseArgs(["--cohort", "--dry-run"]),
      /\[release-manifests\] --cohort requires a file path/,
    );
  });

  it("rejects unknown options", () => {
    assert.throws(
      () => parseArgs(["--unknown-option"]),
      /\[release-manifests\] Unknown option: --unknown-option/,
    );
  });
});

describe("release-set-public-access execution and help", () => {
  it("runCli returns 0 for --help", () => {
    let output = "";
    const origLog = console.log;
    console.log = (msg) => {
      output += msg;
    };
    try {
      const code = runCli(["--help"]);
      assert.equal(code, 0);
      assert.ok(output.includes("Usage: node scripts/release-set-public-access.mjs"));
    } finally {
      console.log = origLog;
    }
  });

  it("main returns help result when --help flag is set", () => {
    const res = main(["--help"]);
    assert.equal(res.changedFiles, 0);
    assert.equal(res.help, true);
  });

  it("executes setPublicAccess dryRun against a mock workspace", () => {
    const fixtureDir = path.join(
      tmp.tmpdir(),
      `rel-pub-access-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(path.join(fixtureDir, "packages", "pkg-a"), { recursive: true });
    writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }, null, 2),
    );
    writeFileSync(
      path.join(fixtureDir, "lerna.json"),
      JSON.stringify({ packages: ["packages/*"] }, null, 2),
    );
    writeFileSync(
      path.join(fixtureDir, "packages", "pkg-a", "package.json"),
      JSON.stringify({ name: "@elizaos/pkg-a", version: "1.0.0" }, null, 2),
    );

    try {
      const result = main(["--repo-root", fixtureDir, "--dry-run"]);
      assert.equal(result.changedFiles, 1);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
