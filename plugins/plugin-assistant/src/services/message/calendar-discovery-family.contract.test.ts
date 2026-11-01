// Real registered Calendar families and shared discovery; no model/domain execution.
import assert from "node:assert/strict";
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import React from "react";
import { test } from "vitest";

Object.assign(globalThis, { React });
const { calendarPlugin } = await import(
  "../../../../plugin-calendar/src/plugin.ts"
);
const { calendarAction, calendarActionPromotionOptions } = await import(
  "../../../../plugin-personal-assistant/src/actions/calendar.ts"
);
const { promoteSubactionsToActions, promotedSubactionParent, AgentRuntime } =
  await import("@elizaos/core");
const { buildActionCatalog } = await import("../../runtime/action-catalog.ts");
const { retrieveActions } = await import("../../runtime/action-retrieval.ts");
const { retrieveContextualPlannerActions } = await import(
  "./action-surface.ts"
);
const { createPlannerToolDiscoveryAction } = await import(
  "./tool-discovery.ts"
);
const { collectPlannerTools } = await import("./planned-tool.ts");
const { stageOneNamesPlannerTool } = await import("./pipeline.ts");
function family(): Action[] {
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
const message: Memory = {
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
      const actions = family();
      const loaded: Action[] = [];
      const discovery = createPlannerToolDiscoveryAction(
        actions,
        (a) => loaded.push(...a),
        undefined,
        { taskIntents: [intent] },
      );
      assert.ok(discovery.handler);
      const result = await discovery.handler(
        { contexts: new Map() } as unknown as IAgentRuntime,
        message,
        undefined,
        { parameters: { contexts: ["calendar"] } },
      );
      assert.ok(result);
      assert.equal(result.success, true);
      assert.ok(result.data);
      assert.ok(Array.isArray(result.data.loadedTools));
      assert.ok(result.data.loadedTools.includes("CALENDAR"));
      assert.ok(!result.data.loadedTools.includes("CALENDAR_SEARCH_EVENTS"));
      const parent = loaded.find((a) => a.name === "CALENDAR");
      assert.ok(parent);
      assert.ok(parent.subActions);
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
// Live direct stage: Stage 1 named CALENDAR while the catalog held only the
// promoted children. Each child carries the umbrella name, so retrieval
// dropped it as ambiguous ("simile claimed by multiple parents").
test("Calendar umbrella name hints its whole family when the umbrella is absent", () => {
  const standalone = calendarPlugin.actions ?? [];
  const others = standalone.filter(
    (a) => a.name !== "CALENDAR" && !promotedSubactionParent(a),
  );
  for (const actions of [
    standalone,
    promoteSubactionsToActions(calendarAction, calendarActionPromotionOptions),
  ]) {
    const children = actions.filter(
      (a) => promotedSubactionParent(a) === "CALENDAR",
    );
    const familyNames = children.map((a) => a.name).sort();
    const catalog = buildActionCatalog([...children, ...others]);
    const catalogNames = new Set(catalog.parents.map((p) => p.name));
    for (const [text, simile, wanted] of [
      ["Delete my calendar event", "DELETE_EVENT", "CALENDAR_DELETE_EVENT"],
      ["Create a calendar event", "CREATE_EVENT", "CALENDAR_CREATE_EVENT"],
    ]) {
      const hinted = (candidateActions: string[]) => {
        const { results, query } = retrieveActions({
          catalog,
          messageText: text,
          candidateActions,
        });
        return {
          results: results.map((r) => r.name),
          hints: query.parentActionHints
            .filter((name) => catalogNames.has(name))
            .sort(),
        };
      };
      // The umbrella name alone hints every operation, so the family
      // outranks the non-family Calendar actions.
      const umbrella = hinted(["CALENDAR"]);
      assert.deepEqual(umbrella.hints, familyNames);
      assert.deepEqual(
        umbrella.results.slice(0, familyNames.length).sort(),
        familyNames,
      );
      // Named beside one operation, it leaves that operation the only hint.
      const precise = hinted(["CALENDAR", simile]);
      assert.deepEqual(precise.hints, [wanted]);
      assert.equal(precise.results[0], wanted);
    }
    // The name stays ambiguous when an action outside the family claims it.
    const { query } = retrieveActions({
      catalog: buildActionCatalog([
        ...children,
        ...others,
        { name: "MEETING_NOTES", description: "Notes.", similes: ["CALENDAR"] },
      ]),
      messageText: "Delete my calendar event",
      candidateActions: ["CALENDAR"],
    });
    assert.deepEqual(query.parentActionHints, []);
  }
});
// Hard-tool enforcement: the umbrella stays registered while the planner
// surface holds only its children; Stage 1 naming the umbrella still names
// an exposed tool.
test("Stage 1 naming CALENDAR enforces a tool when only its children are exposed", () => {
  const actions = family();
  const children = actions.filter(
    (a) => promotedSubactionParent(a) === "CALENDAR",
  );
  const tools = collectPlannerTools(
    {
      id: "fixture",
      events: children.map((action) => ({
        id: action.name,
        type: "tool",
        tool: { name: action.name, action },
      })),
    },
    children,
    { canonicalFamilies: true },
  );
  const toolNames = tools.map((t) => t.name);
  assert.ok(!toolNames.includes("CALENDAR"));
  assert.ok(children.every((a) => toolNames.includes(a.name)));
  const runtime = { actions };
  assert.equal(stageOneNamesPlannerTool(runtime, tools, ["CALENDAR"]), true);
  for (const absent of ["CALENDAR_SOURCES", "WEB_SEARCH"])
    assert.equal(stageOneNamesPlannerTool(runtime, tools, [absent]), false);
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
  const actions = family();
  const feed = actions.find((a) => a.name === "CALENDAR_FEED");
  assert.ok(feed);
  const loaded: Action[] = [feed];
  const discovery = createPlannerToolDiscoveryAction(
    actions,
    (next) => {
      for (const action of next)
        if (!loaded.includes(action)) loaded.push(action);
    },
    undefined,
    { taskIntents: ["List the user calendar events"] },
  );
  assert.ok(discovery.handler);
  await discovery.handler(
    { contexts: new Map() } as unknown as IAgentRuntime,
    message,
    undefined,
    { parameters: { contexts: ["calendar"] } },
  );
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
  const parent: Action = {
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
