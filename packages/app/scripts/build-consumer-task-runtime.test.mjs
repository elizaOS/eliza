import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { buildTaskRuntime } from "./build-consumer-task-runtime.mjs";
import { exportCommittedSources } from "./lib/committed-source.mjs";

test("source export rejects ambiguous identity and never copies working-tree edits", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "committed-source-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "source");
  fs.mkdirSync(source);
  const git = (args) =>
    execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
  git(["init", "--quiet"]);
  fs.writeFileSync(path.join(source, "value.txt"), "reviewed");
  git(["add", "value.txt"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const commit = git(["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(source, "value.txt"), "unreviewed");
  const output = path.join(temporary, "out");
  exportCommittedSources(source, commit, output, ["value.txt"]);
  assert.equal(
    fs.readFileSync(path.join(output, "value.txt"), "utf8"),
    "reviewed",
  );
  assert.throws(
    () => exportCommittedSources(source, "HEAD", output, ["value.txt"]),
    /full reviewed/,
  );
  assert.throws(
    () => exportCommittedSources(source, commit, output, ["../value.txt"]),
    /repository source paths/,
  );
  const nested = path.join(source, "nested");
  fs.mkdirSync(nested);
  assert.throws(
    () => exportCommittedSources(nested, commit, output, ["value.txt"]),
    /checkout root/,
  );
});

test("a committed task bundle runs on SQLite and records the consumer's exact source identity", async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "consumer-task-bundle-"),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sourceRoot = path.resolve(import.meta.dirname, "../../.."),
    sourceCommit = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
  const output = path.join(temporary, "runtime.mjs");
  const commandRoot = testOutputPath("consumer-task-build");
  fs.mkdirSync(commandRoot, { recursive: true });
  const commandDirectory = fs.mkdtempSync(path.join(commandRoot, "command-"));
  t.after(() => fs.rmSync(commandDirectory, { recursive: true, force: true }));
  const report = buildTaskRuntime(output, {
    sourceRoot,
    sourceCommit,
    browserSource: path.join(temporary, "browser"),
    commandSource: path.relative(process.cwd(), commandDirectory),
  });
  assert.equal(report.sourceCommit, sourceCommit);
  assert.equal(
    report.bundleSha256,
    createHash("sha256").update(fs.readFileSync(output)).digest("hex"),
  );
  const { SqliteInteractiveTaskStore } = await import(
    pathToFileURL(output).href
  );
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA synchronous=FULL");
  const store = new SqliteInteractiveTaskStore(db);
  assert.ok(store);
  assert.ok(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='interactive_task_journal_v1'",
      )
      .get(),
  );
  assert.ok(
    fs.statSync(path.join(temporary, "browser/messaging/task-events.ts")).size >
      0,
  );
  // Loading the staged public error module must resolve its real transitive
  // dependency, not merely prove the entry file exists.
  const { ElizaError } = await import(
    pathToFileURL(path.join(temporary, "browser/errors.ts")).href
  );
  const browserError = new ElizaError("synthetic consumer error", {
    code: "SYNTHETIC_CONSUMER_FAILURE",
  });
  assert.equal(browserError.code, "SYNTHETIC_CONSUMER_FAILURE");
  assert.ok(browserError instanceof ElizaError);
  const browserProvenance = JSON.parse(
    fs.readFileSync(path.join(temporary, "browser/provenance.json"), "utf8"),
  );
  assert.equal(
    browserProvenance.files["utils/errors.ts"],
    createHash("sha256")
      .update(fs.readFileSync(path.join(temporary, "browser/utils/errors.ts")))
      .digest("hex"),
  );
  const commandBytes = fs.readFileSync(
    path.join(commandDirectory, "command-handler.mjs"),
  );
  const commandProvenance = JSON.parse(
    fs.readFileSync(path.join(commandDirectory, "provenance.json"), "utf8"),
  );
  assert.equal(commandProvenance.sourceCommit, sourceCommit);
  assert.equal(
    commandProvenance.bundleSha256,
    createHash("sha256").update(commandBytes).digest("hex"),
  );
});
