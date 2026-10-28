// Real registered Calendar families and shared discovery; no model/domain execution.
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

globalThis.React = React;
const { calendarPlugin } = await import(
  "../../../../plugin-calendar/src/plugin.ts"
);
const { calendarAction, calendarActionPromotionOptions } = await import(
  "../../../../plugin-personal-assistant/src/actions/calendar.ts"
);
const { promoteSubactionsToActions, AgentRuntime } = await import(
  "@elizaos/core"
);
const { retrieveContextualPlannerActions } = await import(
  "./action-surface.ts"
);
const { createPlannerToolDiscoveryAction } = await import(
  "./tool-discovery.ts"
);
const { collectPlannerTools } = await import("./planned-tool.ts");
function family() {
  const runtime = new AgentRuntime({
    character: { name: "Closed Calendar discovery", bio: [] },
    logLevel: "fatal",
  });
  for (const action of [
    ...promoteSubactionsToActions(
      calendarAction,
      calendarActionPromotionOptions,
    ),
    ...calendarPlugin.actions.filter((a) =>
      ["CALENDAR_SOURCES", "CONFLICT_DETECT", "CALENDAR_REVIEW"].includes(
        a.name,
      ),
    ),
  ])
    runtime.registerAction(action);
  return runtime.actions;
}
const message = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "00000000-0000-4000-8000-000000000002",
  entityId: "00000000-0000-4000-8000-000000000003",
  content: { text: "What's on my calendar?" },
};
for (const intent of [
  "Show my calendar events",
  "List the user calendar events",
])
  test(
    intent +
      " retains the complete parent rather than guessing filtered search",
    async () => {
      const actions = family(),
        loaded = [];
      const discovery = createPlannerToolDiscoveryAction(
        actions,
        (a) => loaded.push(...a),
        undefined,
        { taskIntents: [intent] },
      );
      const result = await discovery.handler(
        { contexts: new Map() },
        message,
        undefined,
        { parameters: { contexts: ["calendar"] } },
      );
      assert.equal(result.success, true);
      assert.ok(result.data.loadedTools.includes("CALENDAR"));
      assert.ok(!result.data.loadedTools.includes("CALENDAR_SEARCH_EVENTS"));
      const parent = loaded.find((a) => a.name === "CALENDAR");
      assert.ok(parent.subActions.includes("CALENDAR_FEED"));
      assert.deepEqual(parent.roleGate, { minRole: "OWNER" });
      const tools = collectPlannerTools(
        {
          id: "fixture",
          events: loaded.map((action) => ({
            id: action.name,
            type: "tool",
            tool: { name: action.name, action },
          })),
        },
        loaded,
        {
          canonicalFamilies: true,
          directActionNames: new Set(loaded.map((a) => a.name)),
        },
      );
      const calendar = tools.find((t) => t.name === "CALENDAR");
      assert.ok(calendar);
      assert.ok(JSON.stringify(calendar.parameters).includes("feed"));
      assert.ok(parent.handler === calendarAction.handler);
    },
  );
for (const [query, wanted] of [
  ["Search my calendar for dentist", "CALENDAR_SEARCH_EVENTS"],
  ["Delete my calendar event", "CALENDAR_DELETE_EVENT"],
  ["What is my next calendar event?", "CALENDAR_NEXT_EVENT"],
])
  test("explicit operation remains narrow: " + query, () => {
    const actions = family(),
      result = retrieveContextualPlannerActions({
        actions,
        query,
        contexts: ["calendar"],
      });
    assert.ok(result.actions.some((a) => a.name === wanted));
    assert.ok(!result.actions.some((a) => a.name === "CALENDAR"));
  });
test("standalone Calendar also keeps complete agenda contract for generic plural event wording", () => {
  const result = retrieveContextualPlannerActions({
    actions: calendarPlugin.actions,
    query: "Show calendar events",
    contexts: ["calendar"],
  });
  assert.ok(result.actions.some((a) => a.name === "CALENDAR"));
});
test("omitted families are never synthesized outside the supplied authorized catalog", () => {
  const actions = family().filter((a) => !a.name.startsWith("CALENDAR"));
  const result = retrieveContextualPlannerActions({
    actions,
    query: "Show calendar events",
    contexts: ["calendar"],
  });
  assert.ok(result.actions.every((a) => actions.includes(a)));
  assert.ok(
    !result.actions.some(
      (a) => a.name === "CALENDAR_FEED" || a.name === "CALENDAR",
    ),
  );
});

test("already loaded feed stays callable beside a later generic context discovery", async () => {
  const actions = family(),
    feed = actions.find((a) => a.name === "CALENDAR_FEED"),
    loaded = [feed];
  const discovery = createPlannerToolDiscoveryAction(
    actions,
    (next) => {
      for (const action of next)
        if (!loaded.includes(action)) loaded.push(action);
    },
    undefined,
    { taskIntents: ["List the user calendar events"] },
  );
  await discovery.handler({ contexts: new Map() }, message, undefined, {
    parameters: { contexts: ["calendar"] },
  });
  assert.equal(loaded[0], feed);
  const tools = collectPlannerTools(
    {
      id: "fixture",
      events: loaded.map((action) => ({
        id: action.name,
        type: "tool",
        tool: { name: action.name, action },
      })),
    },
    loaded,
    {
      canonicalFamilies: true,
      directActionNames: new Set(loaded.map((a) => a.name)),
    },
  );
  assert.ok(tools.some((t) => t.name === "CALENDAR_FEED"));
});
test("the correction is domain-independent and still recognizes a specific operation suffix", () => {
  const parent = {
    name: "LEDGER",
    description: "Manage ledger entries",
    contexts: ["ledger"],
    parameters: [
      {
        name: "action",
        schema: {
          type: "string",
          enum: ["read_entry", "search_entries", "export_csv", "export_json"],
        },
      },
    ],
    handler: async () => {
      throw Error("No domain action may execute");
    },
  };
  const actions = promoteSubactionsToActions(parent);
  const nouns = retrieveContextualPlannerActions({
    actions,
    query: "Show ledger entries",
    contexts: ["ledger"],
  });
  assert.ok(nouns.actions.some((a) => a.name === "LEDGER"));
  assert.ok(!nouns.actions.some((a) => a.name === "LEDGER_SEARCH_ENTRIES"));
  const csv = retrieveContextualPlannerActions({
    actions,
    query: "Ledger csv",
    contexts: ["ledger"],
  });
  assert.ok(csv.actions.some((a) => a.name === "LEDGER_EXPORT_CSV"));
  assert.ok(!csv.actions.some((a) => a.name === "LEDGER_EXPORT_JSON"));
});
