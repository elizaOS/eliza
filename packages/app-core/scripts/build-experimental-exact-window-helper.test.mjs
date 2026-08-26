/** Verifies the optional exact-window helper build plan refuses every non-direct target. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveExperimentalHelperBuildPlan } from "./build-experimental-exact-window-helper.mjs";

test("build plan is direct-macOS-only and names three isolated Swift sources", () => {
  const plan = resolveExperimentalHelperBuildPlan({
    buildVariant: "direct",
    platform: "darwin",
  });
  assert.equal(plan.sourcePaths.length, 3);
  assert.match(plan.outputPath, /computeruse-exact-window-helper$/);
  assert.equal(plan.compilerArguments.includes("swiftc"), true);
});

test("build plan refuses Store even on macOS", () => {
  assert.throws(
    () =>
      resolveExperimentalHelperBuildPlan({
        buildVariant: "store",
        platform: "darwin",
      }),
    /direct distribution variant/,
  );
});

test("build plan refuses direct builds on other platforms", () => {
  assert.throws(
    () =>
      resolveExperimentalHelperBuildPlan({
        buildVariant: "direct",
        platform: "linux",
      }),
    /only be built on macOS/,
  );
});

test("native sequence refuses focus swaps and balances down/up across mutable AX changes", {
  skip: process.platform !== "darwin",
}, () => {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const sourceDir = resolve(
    scriptDir,
    "../platforms/electrobun/direct-only/computeruse-exact-window",
  );
  const temporary = mkdtempSync(join(tmpdir(), "eliza-exact-window-focus-"));
  const executable = join(temporary, "focus-revalidation-fixture");
  try {
    execFileSync(
      "xcrun",
      [
        "swiftc",
        join(sourceDir, "ExperimentalExactWindowProtocol.swift"),
        join(sourceDir, "FocusRevalidationFixture.swift"),
        "-o",
        executable,
      ],
      { stdio: "pipe" },
    );
    const output = execFileSync(executable, [], { encoding: "utf8" });
    assert.equal(
      output.trim(),
      [
        "focus-revalidation-refused-before-post",
        "mutable-change-after-down-posted-matched-up",
      ].join("\n"),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
