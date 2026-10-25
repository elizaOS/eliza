import assert from "node:assert/strict";
import test from "node:test";
import { GuidedWebsiteWorkflow } from "./guided-website-workflow.mjs";

const page = (name) => ({
  url: `https://site.example/${name}`,
  documentId: `doc-${name}`,
  inputRevision: 1,
  title: name,
  text: `Page ${name}`,
  elements: [],
});

test("the planner sees the step shown on the previous page", async () => {
  const owner = { actorId: "owner" };
  const task = {
    id: "task-1",
    revision: 1,
    epoch: 1,
    status: "active",
    operations: [],
    observation: { id: "observed" },
  };
  const runtime = { owner, get: () => task, observe: async () => {} };
  let current = page("A");
  const actuator = {
    readObservation: () => ({
      observation: task.observation,
      snapshot: current,
    }),
    quiesce: async () => {},
  };
  const seen = [];
  const workflow = new GuidedWebsiteWorkflow({
    runtime,
    actuator,
    taskId: task.id,
    planStep: async ({ page: view, history }) => {
      seen.push({ page: view.title, history });
      return {
        status: "wait",
        step: `Press Next on ${view.title}`,
        message: "",
      };
    },
  });
  for (const name of ["A", "A", "B", "C"]) {
    current = page(name);
    assert.equal((await workflow.refresh()).kind, "wait");
  }
  assert.deepEqual(seen, [
    { page: "A", history: [] },
    { page: "A", history: [] },
    { page: "B", history: ["Press Next on A"] },
    { page: "C", history: ["Press Next on A", "Press Next on B"] },
  ]);
});
