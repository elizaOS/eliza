// Actual Stage-1 field/evaluator and executor code, closed role/registry/route ports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const root = new URL("../../../../", import.meta.url);
const targets = await import(
  new URL("packages/agent/src/runtime/view-navigation-targets.ts", root).href
);
const stageSource = readFileSync(
  new URL("packages/agent/src/runtime/view-navigation.ts", root),
  "utf8",
);
const code = stripTypeScriptTypes(
  stageSource.replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, ""),
  { mode: "transform" },
);
function fixture({
  views = [
    { id: "notes", label: "Notes", available: true },
    { id: "chat", label: "Home", available: true },
    { id: "automations", label: "Automations", available: true },
  ],
  owner = true,
  completed = true,
} = {}) {
  const constraints = [];
  const message = {
    id: "closed-msg",
    roomId: "closed-room",
    entityId: "closed-owner",
    content: {
      text: "Open Workflows",
      source: "client_chat",
      channelType: "DM",
      metadata: {
        uiView: "notes",
        ...(completed ? { viewDelivery: "completed-action" } : {}),
      },
    },
  };
  const runtime = { actions: [{ name: "VIEWS" }] };
  const ports = {
    checkSenderRole: async () => ({
      isOwner: owner,
      role: owner ? "OWNER" : "USER",
    }),
    getStreamingContext: () => undefined,
    getUserMessageText: (m) => m.content.text,
    isObjectRecord: (v) =>
      v !== null && typeof v === "object" && !Array.isArray(v),
    pinnedDiscriminatorForPromotedChild: () => ({
      key: "action",
      value: "show",
    }),
    satisfiesRoleGate: (roles, gate) => !gate || roles.includes(gate.minRole),
    setTurnActionConstraint: (c) => constraints.push(c),
    readViewInteractionClientId: () => "synthetic-client",
    listViews: () => views,
    ...targets,
  };
  const api = new Function(
    ...Object.keys(ports),
    code + ";return {viewNavigationField,viewNavigationEvaluator};",
  )(...Object.values(ports));
  const signal = new AbortController().signal;
  return { api, runtime, message, constraints, signal };
}
async function evaluate(
  f,
  {
    disposition = "unresolved",
    viewId = "workflows",
    replyEffectStatus = "non_applied",
    intents = [],
  } = {},
) {
  const value = {
    disposition,
    viewId,
    reason: "Closed classification fixture",
  };
  f.api.viewNavigationField.handle({
    runtime: f.runtime,
    message: f.message,
    senderRole: "OWNER",
    value,
    turnSignal: f.signal,
  });
  const state = { data: {}, values: {} };
  const out = await f.api.viewNavigationEvaluator.evaluate({
    runtime: f.runtime,
    message: f.message,
    state,
    userRoles: ["OWNER"],
    messageHandler: {
      processMessage: "RESPOND",
      plan: {
        replyEffectStatus,
        intents,
        contexts: ["general"],
        candidateActions: ["VIEWS"],
        parentActionHints: [],
      },
    },
    invalidatedScopeFields: new Set(),
  });
  return { out, state };
}
test("actual Stage1 context advertises Workflows as verified alias of visible canonical Automations", () => {
  const f = fixture();
  const context = f.api.viewNavigationField.getContext({
    runtime: f.runtime,
    message: f.message,
    senderRole: "OWNER",
    turnSignal: f.signal,
  });
  assert.ok(
    context.includes(
      '"id":"automations","label":"Automations","aliases":["workflows"]',
    ),
  );
  assert.ok(context.includes('"id":"chat","label":"Home","aliases":["home"]'));
  assert.match(context, /not permission/);
});
test("recorded unresolved Workflows stays planning, not fabricated direct success, but resolves the canonical known destination", async () => {
  const f = fixture();
  const { out, state } = await evaluate(f);
  assert.equal(
    out,
    undefined,
    "recorded non-applied unresolved decision must not be upgraded",
  );
  assert.ok(
    state.data.providers.VIEW_NAVIGATION.data.views
      .find((v) => v.id === "automations")
      .aliases.includes("workflows"),
  );
});
for (const [target, canonical] of [
  ["workflows", "automations"],
  ["home", "chat"],
  ["notes", "notes"],
])
  test(
    "model-declared direct " +
      target +
      " retains all direct gates and resolver-verified destination",
    async () => {
      const f = fixture();
      const { out } = await evaluate(f, {
        disposition: "direct",
        viewId: target,
        replyEffectStatus: "pending",
        intents: ["Open requested view"],
      });
      assert.equal(out.deterministicToolCall.name, "VIEWS");
      assert.equal(
        out.deterministicToolCall.params.view,
        target === "home" ? "chat" : target,
      );
      const matches = targets.resolveViewNavigationTargets(
        fixture().api
          ? [
              {
                id: canonical,
                label:
                  canonical === "automations"
                    ? "Automations"
                    : canonical === "chat"
                      ? "Home"
                      : "Notes",
              },
            ]
          : [],
        out.deterministicToolCall.params.view,
      );
      assert.equal(matches.length, 1);
      assert.equal(matches[0].view.id, canonical);
    },
  );
for (const [name, views] of [
  ["absent", [{ id: "notes", label: "Notes", available: true }]],
  [
    "unavailable",
    [
      { id: "notes", label: "Notes", available: true },
      { id: "automations", label: "Automations", available: false },
    ],
  ],
  [
    "role denied",
    [
      { id: "notes", label: "Notes", available: true },
      {
        id: "automations",
        label: "Automations",
        available: true,
        roleGate: { minRole: "ADMIN" },
      },
    ],
  ],
])
  test(
    name + " never appears as authorized Stage1 alias or becomes a direct call",
    async () => {
      const f = fixture({ views, completed: false });
      const context = f.api.viewNavigationField.getContext({
        runtime: f.runtime,
        message: f.message,
        senderRole: "OWNER",
        turnSignal: f.signal,
      });
      assert.ok(!context.includes('"workflows"'));
      const { out } = await evaluate(f, {
        disposition: "direct",
        replyEffectStatus: "pending",
        intents: ["Open Workflows"],
      });
      assert.equal(out?.deterministicToolCall, undefined);
    },
  );
test("ambiguous alias, nonowner and forbidden classifier preserve refusal gates", async () => {
  const views = [
    { id: "notes", label: "Notes", available: true },
    { id: "automations", label: "Automations", available: true },
    { id: "other", label: "Workflows", available: true },
  ];
  const a = await evaluate(fixture({ views }), {
    disposition: "direct",
    replyEffectStatus: "pending",
    intents: ["Open Workflows"],
  });
  assert.equal(a.out?.deterministicToolCall, undefined);
  const b = await evaluate(fixture({ owner: false }), {
    disposition: "direct",
    replyEffectStatus: "pending",
    intents: ["Open Workflows"],
  });
  assert.equal(b.out, undefined);
  const f = fixture();
  await evaluate(f, { disposition: "forbidden" });
  assert.equal(f.constraints[0].disposition, "deny");
});
test("helper has no registry side effects and never resolves arbitrary model alias text", () => {
  const views = [{ id: "automations", label: "Automations" }],
    before = JSON.stringify(views);
  assert.deepEqual(
    targets.resolveViewNavigationTargets(views, "workflows injected"),
    [],
  );
  assert.deepEqual(targets.resolveViewNavigationTargets([], "workflows"), []);
  assert.equal(JSON.stringify(views), before);
});

test("completed-action marker cannot make unavailable nonnative destination visible or direct; a true native counterpart keeps existing access", async () => {
  for (const nativeOs of [false, true]) {
    const f = fixture({
      views: [
        { id: "notes", label: "Notes", available: true },
        { id: "automations", label: "Automations", available: false, nativeOs },
      ],
      completed: true,
    });
    const context = f.api.viewNavigationField.getContext({
      runtime: f.runtime,
      message: f.message,
      senderRole: "OWNER",
      turnSignal: f.signal,
    });
    assert.equal(context.includes('"workflows"'), nativeOs);
    const { out } = await evaluate(f, {
      disposition: "direct",
      replyEffectStatus: "pending",
      intents: ["Open Workflows"],
    });
    assert.equal(!!out?.deterministicToolCall, nativeOs);
  }
});

const egressSource = readFileSync(
  new URL(
    "plugins/plugin-assistant/src/services/message/egress-policy.ts",
    root,
  ),
  "utf8",
);
const guardStart = egressSource.indexOf(
    "function navigationClaimIsUngrounded(",
  ),
  guardEnd = egressSource.indexOf(
    "/** Exclude only an exact field label",
    guardStart,
  );
const guardCode = stripTypeScriptTypes(
  egressSource.slice(guardStart, guardEnd),
  { mode: "transform" },
);
const ungrounded = new Function(
  "isRecord",
  guardCode + ";return navigationClaimIsUngrounded;",
)((v) => v !== null && typeof v === "object" && !Array.isArray(v));
test("alias-aware positive completion keeps the same current-state and exact delivered-receipt requirements", () => {
  const providers = {
    VIEW_NAVIGATION: {
      data: {
        currentViewId: "notes",
        views: [
          targets.viewNavigationDestination({
            id: "automations",
            label: "Automations",
          }),
        ],
      },
    },
  };
  assert.equal(
    ungrounded({ reply: "Workflows is open.", providers, actionResults: [] }),
    true,
  );
  providers.VIEW_NAVIGATION.data.currentViewId = "automations";
  assert.equal(
    ungrounded({ reply: "Workflows is open.", providers, actionResults: [] }),
    false,
  );
  assert.equal(
    ungrounded({ reply: "I opened Workflows.", providers, actionResults: [] }),
    true,
  );
  const nav = {
    effect: "view_navigation",
    status: "delivered",
    viewId: "automations",
    label: "Automations",
    handoffId: "fixture-handoff",
  };
  const result = {
    success: true,
    transcriptVisibility: "internal",
    data: {
      view: { id: "automations", label: "Automations" },
      navigation: nav,
    },
    values: {
      completedActionDelivered: true,
      viewId: "automations",
      completedActionHandoffId: "fixture-handoff",
    },
  };
  assert.equal(
    ungrounded({
      reply: "I opened Workflows.",
      providers,
      actionResults: [result],
    }),
    false,
  );
  result.values.completedActionDelivered = false;
  assert.equal(
    ungrounded({
      reply: "I opened Workflows.",
      providers,
      actionResults: [result],
    }),
    true,
  );
});
