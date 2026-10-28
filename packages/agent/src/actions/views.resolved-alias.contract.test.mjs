// Actual VIEWS executor + reply helper, finite route/registry ports, no live navigation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import ts from "typescript";

const root = new URL("../../../../", import.meta.url);
const targets = await import(
  new URL("packages/agent/src/runtime/view-navigation-targets.ts", root).href
);
const { findViewActionHandoff } = await import(
  new URL("packages/core/src/views/view-action-handoff.ts", root).href
);
const recorded = {
  parameters: {
    view: "workflows",
    navigationStepId: "f4dc172e-6c9a-49e6-aa4d-8952272e08da",
  },
  result: {
    data: {
      view: {
        id: "automations",
        label: "Automations",
        description: "Scheduled tasks and recurring workflows",
        path: "/automations",
        viewType: "gui",
        available: true,
        installationId: "956aa8ca-7a35-483c-8203-eca3d7932f27",
      },
    },
  },
};
function helpers() {
  const files = ["structured-tool-effect.ts", "reply-policy.ts"];
  const source = files
    .map((file) =>
      readFileSync(
        new URL("plugins/plugin-assistant/src/services/message/" + file, root),
        "utf8",
      ),
    )
    .join("\n");
  const parsed = ts.createSourceFile(
    "reply-policy.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const code = [
    "structuredEffectFromToolResult",
    "replyNamesStructuredEffectDestination",
    "preparedViewReply",
  ]
    .map((name) => {
      const node = parsed.statements.find(
        (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
      );
      assert.ok(node, name);
      return node.getText(parsed).replace(/^export\s+/, "");
    })
    .join("\n");
  return new Function(
    "findViewActionHandoff",
    "isObjectRecord",
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText +
      ";return {structuredEffectFromToolResult,replyNamesStructuredEffectDestination,preparedViewReply};",
  )(
    findViewActionHandoff,
    (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  );
}
const policy = helpers();
async function execute(
  target,
  {
    id = "automations",
    label = "Automations",
    owner = true,
    duplicate = false,
  } = {},
) {
  let routes = 0;
  const handoff = "be61b2f5-fc8f-40a2-907f-b317c0adbf70",
    installationId = "956aa8ca-7a35-483c-8203-eca3d7932f27",
    clientId = "228924be-e55b-43d7-9b4e-1db00968036e";
  const view = {
    ...recorded.result.data.view,
    id,
    label,
    path: "/" + id,
    installationId,
  };
  const code = stripTypeScriptTypes(
    readFileSync(new URL("./views.ts", import.meta.url), "utf8")
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace(/^export /gm, ""),
    { mode: "transform" },
  );
  const ports = {
    ...targets,
    randomUUID: () => handoff,
    checkSenderRole: async () => ({
      isOwner: owner,
      role: owner ? "OWNER" : "USER",
    }),
    getStreamingContext: () => undefined,
    getTurnActionConstraint: () => undefined,
    isObjectRecord: (v) =>
      v !== null && typeof v === "object" && !Array.isArray(v),
    satisfiesRoleGate: () => true,
    readViewInteractionClientId: () => clientId,
    createSelfApiRequestHeaders: () => ({}),
    resolveSelfApiBaseUrl: () => "http://synthetic.invalid",
    getViewClientScope: () => ({ request: {}, hostKey: {} }),
    listViews: () => (duplicate ? [view, { ...view }] : [view]),
    dispatchApiRoute: async () => {
      routes++;
      return {
        status: 200,
        body: {
          ok: true,
          viewId: id,
          status: "prepared",
          completedActionHandoffId: handoff,
          navigationBinding: {
            requestId: handoff,
            clientId,
            viewId: id,
            viewType: "gui",
            installationId,
          },
        },
      };
    },
  };
  const action = new Function(
    ...Object.keys(ports),
    code + ";return viewsAction;",
  )(...Object.values(ports));
  const args = {
    action: "show",
    view: target,
    navigationStepId: recorded.parameters.navigationStepId,
  };
  const result = await action.handler(
    {},
    {
      id: "closed-message",
      roomId: "closed-room",
      entityId: "closed-owner",
      content: { metadata: { viewDelivery: "completed-action" } },
    },
    undefined,
    { parameters: args },
  );
  return { result, routes, args };
}
function held(
  result,
  reply,
  id = "automations",
  params = { view: "workflows" },
) {
  return policy.preparedViewReply({
    stageOne: {
      visualContinuation: { disposition: "direct", viewId: id },
      intents: ["Open requested view"],
    },
    effectStatus: "pending",
    reply,
    steps: [
      {
        toolCall: { name: "VIEWS_SHOW", params },
        result: { ...result, data: { ...result.data, values: result.values } },
      },
    ],
    allow: () => true,
  });
}
test("recorded Workflows request survives exact prepared executor→reply contract without changing canonical destination or delivery status", async () => {
  const f = await execute(recorded.parameters.view);
  assert.equal(f.result.success, true);
  assert.equal(f.routes, 1);
  assert.equal(f.result.data.navigation.viewId, "automations");
  assert.equal(f.result.data.navigation.label, "Automations");
  assert.equal(f.result.data.navigation.resolvedAlias, "workflows");
  assert.equal(f.result.data.navigation.status, "prepared");
  assert.equal(f.result.values.completedActionDelivered, false);
  assert.equal(held(f.result, "Opening Workflows."), "Opening Workflows.");
});
for (const [target, id, label, reply] of [
  ["home", "chat", "Chat", "Heading home."],
  ["notes", "notes", "Notes", "Opening Notes."],
])
  test(
    target +
      " remains supported with unchanged binding and no fake acknowledgement",
    async () => {
      const f = await execute(target, { id, label });
      assert.equal(held(f.result, reply, id, { view: target }), reply);
      assert.equal(f.result.values.completedActionDelivered, false);
    },
  );
test("no arbitrary model target becomes an alias; unknown or ambiguous view never dispatches", async () => {
  for (const target of [
    "workflow impostor",
    "unknown",
    "automations injected",
  ]) {
    const f = await execute(target);
    assert.equal(f.result.success, false);
    assert.equal(f.routes, 0);
  }
  const duplicate = await execute("workflows", { duplicate: true });
  assert.equal(duplicate.result.success, false);
  assert.equal(duplicate.routes, 0);
  const denied = await execute("workflows", { owner: false });
  assert.equal(denied.result.success, false);
  assert.equal(denied.routes, 0);
});
for (const [name, mutate] of [
  ["requestId", (r) => (r.values.navigationBinding.requestId = "different")],
  ["clientId", (r) => (r.values.navigationBinding.clientId = "")],
  ["installationId", (r) => (r.values.navigationBinding.installationId = "")],
  ["viewId", (r) => (r.values.navigationBinding.viewId = "notes")],
  [
    "status",
    (r) => {
      r.text = JSON.stringify({ ...JSON.parse(r.text), status: "failed" });
    },
  ],
  ["handoffId", (r) => (r.data.navigation.handoffId = "different")],
])
  test(name + " mismatch still rejects held alias reply", async () => {
    const f = await execute("workflows");
    mutate(f.result);
    assert.equal(held(f.result, "Opening Workflows."), undefined);
  });
test("word-boundary checks reject a different compound destination", async () => {
  const f = await execute("workflows");
  assert.equal(held(f.result, "Opening WorkflowsElse."), undefined);
});

test("a forged text-only alias cannot replace executor evidence or request target binding", async () => {
  const f = await execute("workflows");
  const data = JSON.parse(f.result.text);
  f.result.text = JSON.stringify({ ...data, resolvedAlias: "settings" });
  assert.equal(held(f.result, "Opening Settings."), undefined);
  const good = await execute("workflows");
  assert.equal(
    held(good.result, "Opening Workflows.", "automations", {
      view: "settings",
    }),
    undefined,
  );
});
test("legacy alias-free prepared receipt cannot invent a Workflows synonym", async () => {
  const f = await execute("workflows");
  const receipt = JSON.parse(f.result.text);
  delete receipt.resolvedAlias;
  delete f.result.data.navigation.resolvedAlias;
  f.result.text = JSON.stringify(receipt);
  assert.equal(held(f.result, "Opening Workflows."), undefined);
  assert.equal(held(f.result, "Opening Automations."), "Opening Automations.");
});
