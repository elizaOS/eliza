import assert from "node:assert/strict";
import test from "node:test";
import {
  GuidedWebsiteWorkflow,
  pageControls,
  pageView,
} from "./guided-website-workflow.mjs";

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

test("the planner sees page blockers by control ref, never a selector", () => {
  const snapshot = {
    ...page("A"),
    elements: [
      { tag: "button", label: "Reject all", selector: "snap:0:0" },
      { tag: "button", label: "Close", selector: "snap:0:1" },
      {
        tag: "input",
        type: "password",
        label: "Password",
        sensitive: "password",
        selector: "snap:0:2",
      },
    ],
    blockers: [
      {
        kind: "cookie-consent",
        covers: "target",
        rejectRef: "snap:0:0",
        ref: "snap:0:1",
        text: "We use cookies",
      },
      { kind: "modal", covers: "viewport", ref: "snap:0:1" },
      { kind: "login-wall", covers: "viewport", ref: "snap:0:2" },
      { kind: "captcha", covers: "partial", ref: "snap:0:1" },
      // Unknown kinds or coverage from a browser are not shown at all.
      { kind: "Captcha", covers: "partial", ref: "snap:0:1" },
      { kind: "modal", covers: "most", ref: "snap:0:1" },
      null,
      { kind: "paywall", covers: "partial", text: "y".repeat(500) },
    ],
  };
  const index = pageControls(snapshot);
  const view = pageView(snapshot, index);
  const refOf = (label) =>
    index.controls.find(({ element }) => element.label === label).ref;
  assert.deepEqual(view.blockers, [
    // A consent banner offers only its reject control.
    {
      kind: "cookie-consent",
      rejectRef: refOf("Reject all"),
      covers: "target",
      text: "We use cookies",
    },
    { kind: "modal", ref: refOf("Close"), covers: "viewport" },
    // A protected field is never offered as a blocker control.
    { kind: "login-wall", covers: "viewport" },
    // Only the person answers a person check.
    { kind: "captcha", covers: "partial" },
    { kind: "paywall", covers: "partial", text: "y".repeat(200) },
  ]);
  assert.equal(JSON.stringify(view).includes("snap:0:"), false);
  assert.deepEqual(pageView(page("B"), pageControls(page("B"))).blockers, []);
});

test("a host words the outcome of a planned browser action", async () => {
  const task = {
    id: "task-1",
    revision: 1,
    epoch: 1,
    status: "active",
    operations: [],
    authorization: { decisionId: "grant" },
    observation: { id: "observed", version: 1, inputRevision: 1 },
  };
  const snapshot = {
    ...page("A"),
    elements: [
      {
        tag: "button",
        label: "Next",
        selector: "snap:0:0",
        targetSelector: "#next",
      },
    ],
  };
  const results = [
    { status: "failed", evidenceRef: "not-dispatched" },
    { status: "failed", evidenceRef: "evidence:after" },
    { status: "unknown" },
  ];
  const runtime = {
    owner: { actorId: "owner" },
    get: () => task,
    observe: async () => task,
    control: () => {},
    execute: async (_id, _revision, proposal) => ({
      operations: [{ proposal, ...results.shift() }],
    }),
  };
  const workflow = new GuidedWebsiteWorkflow({
    runtime,
    actuator: {
      readObservation: () => ({ observation: task.observation, snapshot }),
      quiesce: async () => {},
    },
    taskId: task.id,
    planStep: async ({ page: view }) => ({
      status: "act",
      kind: "agent-action",
      action: "click",
      ref: view.controls[0].ref,
      step: "Press Next",
      message: "",
    }),
    authorizeAction: () => true,
    words: {
      actionNotSent: "not sent",
      actionUnexpected: "unexpected",
      actionUnverified: "unverified",
    },
  });
  const outcome = async () => {
    const offer = await workflow.refresh();
    assert.equal(offer.kind, "agent-action");
    return workflow.executeAction(offer.offerKey);
  };
  assert.deepEqual(await outcome(), {
    kind: "blocked",
    reason: "not sent",
    reasonCode: "action-not-sent",
  });
  assert.deepEqual(await outcome(), {
    kind: "blocked",
    reason: "unexpected",
    reasonCode: "action-failed",
  });
  assert.deepEqual(await outcome(), {
    kind: "unknown-outcome",
    reasonCode: "action-unverified",
    message: "unverified",
  });
});

test("a lost record of her own pointed submit is asked about only off its page", async () => {
  const task = {
    id: "task-1",
    revision: 1,
    epoch: 1,
    status: "active",
    operations: [],
    observation: { id: "observed" },
  };
  const runtime = {
    owner: { actorId: "owner" },
    get: () => task,
    observe: async () => {},
  };
  // A submit event ID, one per failed submit.
  const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const activity = (gaps, extra = {}) => ({
    events: [],
    overflow: false,
    captureGap: gaps.length > 0,
    captureGapEvents: gaps,
    ...extra,
  });
  const at = (path, documentId, gaps, elements = [], extra = {}) => ({
    ...page("x"),
    url: `https://site.example/${path}`,
    documentId,
    manualActivity: activity(gaps, extra),
    elements,
  });
  const form = { index: 0, name: "Search" };
  const submit = {
    tag: "button",
    label: "Search",
    form,
    submits: true,
    selector: "snap:0:0",
  };
  const details = {
    tag: "button",
    label: "Show details",
    selector: "snap:0:0",
  };
  const field = {
    tag: "input",
    type: "text",
    label: "Name",
    form,
    selector: "snap:0:0",
  };
  const link = {
    tag: "a",
    label: "Invoices",
    href: "https://site.example/invoices#top",
    selector: "snap:0:0",
  };
  const choice = {
    tag: "input",
    type: "checkbox",
    label: "Paperless",
    form,
    selector: "snap:0:0",
  };
  let current;
  const workflow = new GuidedWebsiteWorkflow({
    runtime,
    actuator: {
      readObservation: () => ({
        observation: task.observation,
        snapshot: current,
      }),
      quiesce: async () => {},
    },
    taskId: task.id,
    planStep: async ({ page: view }) =>
      view.controls.length
        ? {
            status: "act",
            ref: view.controls[0].ref,
            step: "Press it",
            message: "",
          }
        : { status: "wait", step: "Wait", message: "" },
  });
  const show = async (snapshot) => {
    current = snapshot;
    return workflow.refresh();
  };
  const asked = async (snapshot) => {
    const result = await show(snapshot);
    assert.equal(result.reason, "manual-activity", snapshot.url);
    return result;
  };
  const steps = async (snapshot) =>
    assert.notEqual((await show(snapshot)).kind, "person-check", snapshot.url);

  // She presses the submit button she was shown; the page moves to another
  // address in the same document and the record of that submit was lost.
  // That is her step, not something to check.
  await steps(at("search", "doc-1", [], [submit]));
  await steps(at("results", "doc-1", [id(1)], [details]));
  await steps(at("results/2", "doc-1", [id(1)], [details]));
  // A second failed submit in that document is asked about, though the
  // first was explained.
  const second = await asked(at("results/2", "doc-1", [id(1), id(2)]));
  // Her answer covers those submits in that document at any of its
  // addresses; the same address loaded again with a new failure asks again.
  workflow.acknowledge(second.key);
  await steps(at("results/3?page=2", "doc-1", [id(1), id(2)], [details]));
  const reloaded = await asked(at("results/2", "doc-1b", [id(3)]));
  assert.notEqual(reloaded.key, second.key);
  workflow.acknowledge(reloaded.key);
  assert.notEqual(
    (await asked(at("results/2", "doc-1b", [id(3), id(4)]))).key,
    reloaded.key,
  );

  // A gap on the page she was pointed on (no new address) is asked about.
  await steps(at("form", "doc-2", [], [submit]));
  await asked(at("form", "doc-2", [id(5)]));
  // A wait step points at nothing of hers.
  await steps(at("wait", "doc-3", []));
  await asked(at("wait/next", "doc-3", [id(6)]));
  // A button that sends no form, a link and a choice send no form of hers.
  for (const [n, control] of [
    [7, details],
    [8, link],
    [9, choice],
  ]) {
    await steps(at("list", `doc-${n}`, [], [control]));
    await asked(at("invoices", `doc-${n}`, [id(n)]));
  }
  // A gap in another document is never her pointed submit's.
  await steps(at("search", "doc-10", [], [submit]));
  await asked(at("results", "doc-11", [id(10)]));
  // A field of a form she sends with Enter is a submit step.
  await steps(at("search", "doc-12", [], [field]));
  await steps(at("results", "doc-12", [id(12)], [details]));
  // The pointed step explains only the next page read after it.
  await steps(at("search", "doc-13", [], [submit]));
  await steps(at("results", "doc-13", [], [details]));
  await asked(at("results/2", "doc-13", [id(13)]));
  // A step shown with a gap already open explains nothing.
  workflow.acknowledge(
    (await asked(at("search", "doc-14", [id(14)], [submit]))).key,
  );
  await steps(at("search", "doc-14", [id(14)], [submit]));
  await asked(at("results", "doc-14", [id(15)]));
  // One pointed submit explains one failed submit, never two.
  await steps(at("search", "doc-19", [], [submit]));
  await asked(at("results", "doc-19", [id(19), id(20)]));
  // A browser that names no submit reports a gap that is always asked about.
  await steps(at("search", "doc-15", [], [submit]));
  current = at("results", "doc-15", []);
  current.manualActivity = { events: [], overflow: false, captureGap: true };
  assert.equal((await workflow.refresh()).reason, "manual-activity");

  // Overflow, and a form sent before this epoch, are still asked about.
  await steps(at("search", "doc-16", [], [submit]));
  await asked(at("results", "doc-16", [], [], { overflow: true }));
  task.epoch = 2;
  const earlier = {
    kind: "form-submit",
    origin: "https://site.example",
    documentId: "doc-16",
    epoch: 1,
    observedAt: 1,
  };
  await asked(at("next", "doc-17", [], [], { events: [earlier] }));
  // An answer from one epoch never covers the same gap in the next.
  const inEpoch = await asked(at("other", "doc-18", [id(16)]));
  workflow.acknowledge(inEpoch.key);
  task.epoch = 3;
  assert.notEqual(
    (await asked(at("other", "doc-18", [id(16)]))).key,
    inEpoch.key,
  );
});

test("browser gap evidence that names submits is checked", async () => {
  const task = {
    id: "task-1",
    revision: 1,
    epoch: 1,
    status: "active",
    operations: [],
    observation: { id: "observed" },
  };
  for (const manualActivity of [
    {
      events: [],
      overflow: false,
      captureGap: false,
      captureGapEvents: ["11111111-0000-4000-8000-000000000000"],
    },
    {
      events: [],
      overflow: false,
      captureGap: true,
      captureGapEvents: ["not an id"],
    },
    { events: [], overflow: false, captureGap: true, captureGapEvents: "x" },
  ]) {
    const workflow = new GuidedWebsiteWorkflow({
      runtime: {
        owner: { actorId: "owner" },
        get: () => task,
        observe: async () => {},
      },
      actuator: {
        readObservation: () => ({
          observation: task.observation,
          snapshot: { ...page("x"), manualActivity },
        }),
        quiesce: async () => {},
      },
      taskId: task.id,
      planStep: async () => ({ status: "wait", step: "Wait", message: "" }),
    });
    await assert.rejects(workflow.refresh(), /Invalid manual activity/);
  }
});
