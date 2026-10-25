import assert from "node:assert/strict";
import test from "node:test";
import {
  controls,
  deriveBillDecision,
} from "../test/fixtures/bill-host/policy.mjs";
import { BillWorkflow } from "./bill-workflow.mjs";

const decision = { kind: "choose-existing-method", reviewKey: "review" };
const snapshot = {
  elements: [
    { selector: "observed-method", label: controls.existingMethod.label },
  ],
};
const options = {
  deriveBillDecision,
  controls,
  runtime: { owner: {} },
  bill: {},
  taskId: "task",
};

test("required selection guidance withholds the choice when target, capability or display is unavailable", async () => {
  for (const failure of ["target", "capability", "display"]) {
    let cleared = 0;
    const policy = {
      unavailableMessage:
        "Bring the saved method into view. No selection was sent.",
    };
    const actuator = {
      quiesce: async () => {
        cleared++;
      },
      ...(failure === "capability"
        ? {}
        : {
            showGuidance: async () => {
              if (failure === "display") throw Error("Unavailable");
            },
          }),
    };
    const workflow = new BillWorkflow({
      ...options,
      actuator,
      selectionGuidance: policy,
    });
    policy.unavailableMessage = "mutated";
    const result = await workflow.guide(
      decision,
      failure === "target" ? { elements: [] } : snapshot,
      false,
    );
    assert.equal(result.kind, "human-review");
    assert.equal(result.guidance.available, false);
    assert.match(result.message, /No selection was sent/);
    assert.equal(result.reviewKey, undefined);
    assert.equal(cleared, 1);
  }
  const legacy = new BillWorkflow({ ...options, actuator: {} });
  assert.equal(
    (await legacy.guide(decision, snapshot, false)).kind,
    "choose-existing-method",
  );
  const required = new BillWorkflow({
    ...options,
    actuator: { showGuidance: async () => {} },
    selectionGuidance: { unavailableMessage: "Not available" },
  });
  assert.equal(
    (await required.guide(decision, snapshot, false)).guidance.available,
    true,
  );
});

test("required guidance accepts only bounded host-supplied recovery copy", () => {
  for (const selectionGuidance of [
    false,
    [],
    {},
    { unavailableMessage: "" },
    { unavailableMessage: " ".repeat(2) },
    { unavailableMessage: "x".repeat(601) },
    { unavailableMessage: "Valid", other: true },
  ])
    assert.throws(
      () => new BillWorkflow({ ...options, actuator: {}, selectionGuidance }),
      /guidance policy/,
    );
});

test("a stale or revoked selection cannot pause the current task after unavailable guidance", async () => {
  for (const guard of ["choice", "owner", "abort"]) {
    let pauses = 0;
    const signal = new AbortController();
    if (guard === "abort") signal.abort();
    const workflow = new BillWorkflow({
      ...options,
      signal: signal.signal,
      actuator: {},
      selectionGuidance: { unavailableMessage: "Unavailable" },
      stillAuthorized: async () => guard !== "owner",
      runtime: {
        owner: {},
        get: () => ({ id: "task", revision: 1, status: "active" }),
        control: () => {
          pauses++;
        },
        settle: async () => {},
      },
    });
    workflow.refresh = async () => ({
      kind: "human-review",
      guidance: { available: false },
    });
    assert.equal(
      (
        await workflow.chooseExistingMethod("review", {
          isCurrent: () => guard !== "choice",
        })
      ).kind,
      "blocked",
    );
    assert.equal(pauses, 0);
  }
});
