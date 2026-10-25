import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runUpdaterContractFixture,
  stageUpdaterContractFixture,
} from "../../scripts/updater-contract-fixtures.mjs";

const fixtures = [
  "JobRunRegistryTest",
  "PreparationFlowTest",
  "ProbationWindowTest",
  "QualifiedClockAnchorTest",
  "UpdateJournalTest",
];
test("consumer contracts retain every assertion and rebind static imports to adapters", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-updater-contract-"),
  );
  try {
    for (const fixture of fixtures) {
      const result = stageUpdaterContractFixture({
        fixture,
        packageName: "example.consumer.updater",
        outputDirectory: directory,
      });
      const original = fs.readFileSync(
        new URL(`./${fixture}.java`, import.meta.url),
        "utf8",
      );
      const staged = fs.readFileSync(result.file, "utf8");
      assert.equal(
        staged.replaceAll(
          "example.consumer.updater",
          "ai.eliza.plugins.agent.updater",
        ),
        original,
      );
      assert.equal(result.mainClass, `example.consumer.updater.${fixture}`);
      assert.match(result.canonicalSha256, /^[a-f0-9]{64}$/);
      assert.ok(result.sharedSources.every((file) => fs.existsSync(file)));
      assert.equal(staged.includes("ai.eliza.plugins.agent.updater"), false);
      assert.throws(
        () =>
          stageUpdaterContractFixture({
            fixture,
            packageName: "different.package",
            outputDirectory: directory,
          }),
        { code: "EEXIST" },
      );
      assert.equal(fs.readFileSync(result.file, "utf8"), staged);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("invalid fixture names, packages and relative output cannot write source", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-updater-contract-"),
  );
  try {
    const options = {
      fixture: fixtures[0],
      packageName: "example.consumer",
      outputDirectory: directory,
    };
    for (const patch of [
      { fixture: "../escape" },
      { packageName: "example; import malicious" },
      { packageName: "../escape" },
      { packageName: "" },
      { outputDirectory: "relative" },
    ]) {
      assert.throws(() =>
        stageUpdaterContractFixture({ ...options, ...patch }),
      );
    }
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runner executes the canonical JVM assertions and propagates compiler failures", () => {
  const result = runUpdaterContractFixture({
    fixture: "JobRunRegistryTest",
    processTimeoutMs: 30000,
  });
  assert.match(result.stdout, /JobRunRegistry: 26 assertions passed/);
  assert.equal(
    result.mainClass,
    "ai.eliza.plugins.agent.updater.JobRunRegistryTest",
  );
  assert.throws(() =>
    runUpdaterContractFixture({
      fixture: "JobRunRegistryTest",
      processTimeoutMs: 0,
    }),
  );
  assert.throws(() =>
    runUpdaterContractFixture({
      fixture: "JobRunRegistryTest",
      processTimeoutMs: 30000,
      javaHome: path.join(os.tmpdir(), "missing-eliza-jdk"),
    }),
  );
});
test("JVM contract failures expose a broken consumer adapter instead of testing the shared type", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-broken-updater-"),
  );
  try {
    fs.writeFileSync(
      path.join(directory, "JobRunRegistry.java"),
      `package example.broken;
public class JobRunRegistry extends ai.eliza.plugins.agent.updater.JobRunRegistry {
 public JobRunRegistry(java.util.concurrent.Executor workers,java.util.concurrent.Executor lifecycle){super(workers,lifecycle);}
 @Override public synchronized int size(){return 42;}
}`,
    );
    assert.throws(
      () =>
        runUpdaterContractFixture({
          fixture: "JobRunRegistryTest",
          packageName: "example.broken",
          adaptersDirectory: directory,
          processTimeoutMs: 30000,
        }),
      (error) =>
        error.status !== 0 &&
        String(error.stderr).includes(
          "example.broken.JobRunRegistryTest.check",
        ),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
