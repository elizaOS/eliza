/** Verifies the optional exact-window helper build plan refuses every non-direct target. */

import assert from "node:assert/strict";
import test from "node:test";
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
