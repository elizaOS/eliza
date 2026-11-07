import assert from "node:assert/strict";
import test from "node:test";
import {
  controls as defaultControls,
  deriveBillDecision,
} from "../test/fixtures/bill-host/policy.mjs";
import { matchBillControl, validateBillControls } from "./bill-controls.mjs";
import { BillWorkflow } from "./bill-workflow.mjs";

test("site controls require an exact method selector and distinct labels without executable policy", () => {
  const valid = validateBillControls(defaultControls);
  assert.equal(Object.isFrozen(valid.existingMethod), true);
  for (const controls of [
    { ...valid, execute: "anything" },
    {
      ...valid,
      existingMethod: { ...valid.existingMethod, selector: "button, #pay" },
    },
    { ...valid, submit: { ...valid.submit, selector: "#pay" } },
    {
      ...valid,
      existingMethod: { ...valid.existingMethod, label: valid.submit.label },
    },
    { ...valid, submit: { ...valid.submit, label: "Pay\nnow" } },
  ])
    assert.throws(() => validateBillControls(controls));
});
test("ambiguous or changed labels cannot resolve an observation reference", () => {
  const control = { label: "Use saved Visa", selector: "#savedMethod" };
  assert.deepEqual(
    matchBillControl(
      { elements: [{ ...control, selector: "observation:frame:7" }] },
      control,
    ),
    { ...control, selector: "observation:frame:7" },
  );
  assert.equal(
    matchBillControl({ elements: [control, control] }, control),
    null,
  );
  assert.equal(
    matchBillControl({ elements: [{ ...control, label: "Pay now" }] }, control),
    null,
  );
  assert.deepEqual(matchBillControl({ elements: [control] }, control), control);
});
test("workflow selects only the configured existing-method target after review", async () => {
  const controls = {
    ...validateBillControls(defaultControls),
    existingMethod: { selector: "#savedMethod", label: "Use saved Visa" },
  };
  const task = {
    id: "task",
    revision: 1,
    epoch: 1,
    authorization: { decisionId: "approval" },
  };
  let elements = [{ selector: "observation:frame:7", label: "Other control" }],
    executions = 0;
  let selectedStatus = "succeeded";
  const runtime = {
    owner: {},
    get: () => task,
    execute: async (_id, _rev, proposal) => {
      executions++;
      assert.equal(proposal.targetRef, "observation:frame:7");
      assert.equal(proposal.capability, "browser.click");
      return {
        operations: [
          { proposal, status: selectedStatus },
          { proposal: { id: "unrelated" }, status: "succeeded" },
        ],
      };
    },
  };
  const workflow = new BillWorkflow({
    deriveBillDecision,
    controls,
    outcomes: { recordMethodSelection() {} },
    runtime,
    bill: {},
    taskId: task.id,
    actuator: {
      readObservation: () => ({
        observation: { id: "observation", version: 1, inputRevision: 0 },
        snapshot: { elements },
      }),
    },
  });
  workflow.refresh = async () => ({
    kind: "choose-existing-method",
    reviewKey: "review",
  });
  assert.equal((await workflow.chooseExistingMethod("review")).kind, "blocked");
  assert.equal(executions, 0);
  elements = [
    { label: controls.existingMethod.label, selector: "observation:frame:7" },
  ];
  await workflow.chooseExistingMethod("stale");
  assert.equal(executions, 0);
  await workflow.chooseExistingMethod("review");
  assert.equal(executions, 1);
  const outcomes = workflow.outcomes;
  workflow.outcomes = undefined;
  assert.equal((await workflow.chooseExistingMethod("review")).kind, "blocked");
  assert.equal(executions, 1);
  workflow.outcomes = outcomes;
  selectedStatus = "failed";
  assert.equal(
    (await workflow.chooseExistingMethod("review")).kind,
    "unknown-outcome",
  );
});
