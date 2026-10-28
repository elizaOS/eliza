// Runs the production terminal-selection block and existing strict prepared-handoff helper.
// No model, delivery, provider or device calls. SDK: node --test <this file>.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";
import ts from "typescript";

const root = new URL("../../../../../", import.meta.url);
const core = await build({
  entryPoints: [
    new URL("packages/core/src/views/view-action-handoff.ts", root).pathname,
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { findViewActionHandoff } = await import(
  "data:text/javascript;base64," +
    Buffer.from(core.outputFiles[0].text).toString("base64")
);
const policy = ts.createSourceFile(
  "reply-policy.ts",
  readFileSync(new URL("./reply-policy.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const effectPolicy = ts.createSourceFile(
  "structured-tool-effect.ts",
  readFileSync(new URL("./structured-tool-effect.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const functions = [
  "structuredEffectFromToolResult",
  "replyNamesStructuredEffectDestination",
  "preparedViewReply",
]
  .map((name) => {
    const source = name === "preparedViewReply" ? policy : effectPolicy;
    const n = source.statements.find(
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
    );
    assert.ok(n, name);
    return n.getText(source).replace(/^export\s+/, "");
  })
  .join("\n");
const helper = new Function(
  "findViewActionHandoff",
  "isObjectRecord",
  ts.transpileModule(functions, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText + ";return preparedViewReply;",
)(
  findViewActionHandoff,
  (v) => v !== null && typeof v === "object" && !Array.isArray(v),
);
const pipeline = readFileSync(
  new URL("./pipeline.ts", import.meta.url),
  "utf8",
);
const begin = pipeline.indexOf(
  '    if (\n      plannerResult.status === "finished"',
  pipeline.indexOf("let plannedReplyEgressDecision ="),
);
const end = pipeline.indexOf("\n    emitNavigationDiagnostic", begin);
assert.ok(begin > 0 && end > begin);
const selected = pipeline.slice(begin, end);
const run = new Function(
  "plannerResult",
  "args",
  "parsedResponseHandlerReply",
  "fieldRunResult",
  "prePatchStageOneReplyEffectStatus",
  "evaluateCandidateReply",
  "sanitizeUserVisibleModelOutput",
  "preparedViewReply",
  "let plannedReplyEgressDecision=evaluateCandidateReply(plannerResult.finalMessage);" +
    selected +
    ";return plannerResult;",
);
function fixture() {
  const id = "11111111-1111-4111-8111-111111111111";
  const values = {
    mode: "show",
    viewId: "notes",
    completedActionHandoffId: id,
    navigationPrepared: true,
    navigationBinding: {
      requestId: id,
      clientId: "renderer",
      installationId: "installed",
      viewId: "notes",
      viewType: "gui",
    },
  };
  return {
    result: {
      status: "finished",
      trajectory: {
        plannedQueue: [],
        steps: [
          {
            toolCall: { name: "VIEWS_SHOW" },
            result: {
              success: true,
              text: JSON.stringify({
                effect: "view_navigation",
                status: "prepared",
                label: "Notes",
                viewId: "notes",
              }),
              data: { values, navigation: { handoffId: id } },
            },
          },
        ],
      },
      finalMessage:
        "Notes did not open; the switch prepared but was not delivered.",
    },
    stageOne: {
      visualContinuation: { disposition: "direct", viewId: "notes" },
      intents: ["Open Notes"],
    },
    held: "Opening Notes.",
    effect: "pending",
    allow: true,
  };
}
function select(a) {
  return run(
    a.result,
    {},
    a.held,
    { parsed: a.stageOne },
    a.effect,
    () => ({
      verdict: a.allow ? "allow" : "reject",
      ...(a.allow ? {} : { kind: "view_navigation" }),
    }),
    (s) =>
      typeof s === "string" && s.trim()
        ? { kind: "text", text: s }
        : { kind: "empty" },
    helper,
  );
}
test("allowed negative terminal prose cannot displace held voice for exact pending navigation", () => {
  const a = fixture();
  assert.equal(select(a).finalMessage, "Opening Notes.");
  assert.equal(
    a.result.trajectory.steps[0].result.data.values.completedActionDelivered,
    undefined,
  );
  assert.equal(
    a.result.trajectory.steps[0].result.data.values.navigationPrepared,
    true,
  );
});
for (const [name, mutate] of [
  [
    "mismatched binding",
    (a) =>
      (a.result.trajectory.steps[0].result.data.navigation.handoffId =
        "changed"),
  ],
  [
    "extra real action",
    (a) =>
      a.result.trajectory.steps.push({ toolCall: { name: "NOTES_CREATE" } }),
  ],
  ["nonpending declaration", (a) => (a.effect = "non_applied")],
  [
    "different destination",
    (a) => (a.stageOne.visualContinuation.viewId = "calendar"),
  ],
  ["no held wording", (a) => (a.held = "")],
  ["egress refusal", (a) => (a.allow = false)],
  ["terminal failure", (a) => (a.result.terminalFailure = { code: "failure" })],
  [
    "queued work",
    (a) => a.result.trajectory.plannedQueue.push({ name: "NOTES_CREATE" }),
  ],
])
  test(
    name + " preserves the original result without handoff promotion",
    () => {
      const a = fixture();
      mutate(a);
      assert.equal(select(a).finalMessage, a.result.finalMessage);
    },
  );
test("effect-free terminal synthesis does not count as another action", () => {
  const a = fixture();
  a.result.trajectory.steps.push({
    terminalOnly: true,
    terminalMessage: a.result.finalMessage,
  });
  assert.equal(select(a).finalMessage, a.held);
});
const loop = ts.createSourceFile(
  "planner-loop.ts",
  readFileSync(
    new URL("../../runtime/planner-loop.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
let event;
function walk(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(loop) === "postToolReplyEvent"
  )
    event = node.initializer.getText(loop);
  ts.forEachChild(node, walk);
}
walk(loop);
assert.ok(event);
const eventFor = new Function(
  "postToolReplySeed",
  "hasAwaitingDeviceExecutionMarker",
  "findViewActionHandoff",
  ts.transpileModule("return " + event, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText,
);
function seed() {
  const a = fixture();
  return a.result.trajectory.steps[0];
}
test("prepared renderer handoff gets prospective synthesis instructions without claiming acknowledgement", () => {
  const a = seed();
  a.result.data.awaitingDeviceExecution = true;
  const e = eventFor(
    a,
    (v) => v?.data?.awaitingDeviceExecution === true,
    findViewActionHandoff,
  );
  assert.match(e.content, /only after receiving that reply/);
  assert.match(e.content, /Preparation is not failure or proof of nondelivery/);
  assert.match(e.content, /Do not call or repeat any tool/);
  assert.equal(a.result.data.values.completedActionDelivered, undefined);
});
for (const [label, mutate] of [
  [
    "ordinary external request",
    (a) => {
      a.toolCall.name = "CALENDAR_CREATE_EVENT";
    },
  ],
  [
    "malformed prepared binding",
    (a) => (a.result.data.values.navigationBinding.requestId = "different"),
  ],
])
  test(label + " retains ordinary external pending policy", () => {
    const a = seed();
    mutate(a);
    a.result.data.awaitingDeviceExecution = true;
    const e = eventFor(
      a,
      (v) => v?.data?.awaitingDeviceExecution === true,
      findViewActionHandoff,
    );
    assert.match(e.content, /still pending on the external device/);
    assert.doesNotMatch(e.content, /originating renderer/);
  });
test("settled results retain final rather than prospective synthesis policy", () => {
  const e = eventFor(seed(), () => false, findViewActionHandoff);
  assert.match(e.content, /already settled and complete/);
  assert.match(e.content, /Do not describe the work as starting/);
});
