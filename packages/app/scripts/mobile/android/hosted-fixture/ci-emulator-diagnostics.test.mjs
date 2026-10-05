import assert from "node:assert/strict";
import test from "node:test";
import { captureFixtureDisplayEvidence } from "./ci-emulator-diagnostics.mjs";

test("diagnostics retain bounded raw policy and fixed guest identities without mutation", () => {
  const commands = [];
  const result = captureFixtureDisplayEvidence((args, timeout) => {
    commands.push(args);
    assert.ok(timeout > 0 && timeout <= 2_000);
    if (args.includes("power")) return "p".repeat(70_000);
    if (args.includes("policy")) return "secure=true\nsystemIsReady=true\n";
    if (args.includes("ro.product.name")) throw Error("diagnostic unavailable");
    return "fixture";
  });
  assert.equal(result.reads.power.output.length, 65_536);
  assert.equal(result.reads.power.truncated, true);
  assert.equal(
    result.reads.windowPolicy.output,
    "secure=true\nsystemIsReady=true\n",
  );
  assert.deepEqual(result.reads["ro.product.name"], { unavailable: true });
  assert.equal(commands.length, 11);
  assert.ok(
    commands.every(
      (args) => args[0] === "shell" && ["dumpsys", "getprop"].includes(args[1]),
    ),
  );
});

test("failed diagnostic commands consume a shared 15 second budget without further reads", () => {
  let elapsed = 0;
  const timeouts = [];
  const result = captureFixtureDisplayEvidence(
    (_args, timeout) => {
      timeouts.push(timeout);
      elapsed += timeout;
      throw Error("command timed out");
    },
    { now: () => elapsed },
  );
  assert.deepEqual(
    timeouts,
    [2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 1_000],
  );
  assert.equal(elapsed, 15_000);
  assert.equal(
    Object.values(result.reads).filter((value) => value.budgetExhausted).length,
    3,
  );
  assert.ok(Object.values(result.reads).every((value) => value.unavailable));
});
