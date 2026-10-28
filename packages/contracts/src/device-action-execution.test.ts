import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeviceActionExecution } from "./device-action-execution.ts";

const identity = {
  scope: "a".repeat(64),
  proposalId: "proposal",
  operationId: "operation",
};
const fresh = () =>
  createDeviceActionExecution(identity, new AbortController().signal, () => {});

test("one exact admitted identity can dispatch and settle once", () => {
  const attempt = fresh();
  assert.ok(Object.isFrozen(attempt.identity));
  assert.equal(attempt.dispatched, false);
  for (const changed of [
    { ...identity, scope: "b".repeat(64) },
    { ...identity, proposalId: "other" },
    { ...identity, operationId: "other" },
  ])
    assert.throws(() => attempt.markDispatched(changed), /identity changed/);
  attempt.markDispatched(identity);
  assert.equal(attempt.dispatched, true);
  assert.throws(() => attempt.markDispatched(identity), /no longer available/);
  attempt.settle(identity);
  assert.throws(() => attempt.settle(identity), /no unsettled dispatch/);
});

test("retirement, cancellation and stale ownership prevent a new dispatch", () => {
  const retired = fresh();
  retired.retire();
  assert.throws(() => retired.markDispatched(identity), /no longer available/);
  const cancelled = new AbortController();
  const attempt = createDeviceActionExecution(
    identity,
    cancelled.signal,
    () => {},
  );
  cancelled.abort();
  assert.throws(() => attempt.markDispatched(identity), { name: "AbortError" });
  let current = true;
  const owned = createDeviceActionExecution(
    identity,
    new AbortController().signal,
    () => {
      if (!current) throw Error("Owner changed");
    },
  );
  current = false;
  assert.throws(() => owned.markDispatched(identity), /Owner changed/);
});

test("a known result can settle after retirement without permitting another dispatch", () => {
  const aborted = new AbortController();
  const attempt = createDeviceActionExecution(identity, aborted.signal, () => {
    throw Error("Owner changed");
  });
  // Use a current owner at admission, then retire only after dispatch.
  const current = createDeviceActionExecution(
    identity,
    aborted.signal,
    () => {},
  );
  current.markDispatched(identity);
  current.retire();
  aborted.abort();
  current.settle(identity);
  assert.throws(() => current.markDispatched(identity));
  assert.throws(() => attempt.settle(identity), /no unsettled dispatch/);
});

test("malformed identities cannot become an attempt", () => {
  for (const value of [
    null,
    {},
    { ...identity, scope: "A".repeat(64) },
    { ...identity, proposalId: "../other" },
    { ...identity, operationId: "" },
  ]) {
    assert.throws(
      () =>
        createDeviceActionExecution(
          value,
          new AbortController().signal,
          () => {},
        ),
      /Invalid device action execution identity/,
    );
  }
});
