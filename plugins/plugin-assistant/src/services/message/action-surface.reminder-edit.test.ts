/** Live tj-d24d0ef3e2f2ed: a reminder edit phrased as delete + set keeps its in-place update. */
import {
  type Action,
  type ContextObject,
  type IAgentRuntime,
  type Memory,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { triggerAction } from "../../../../../packages/agent/src/actions/trigger.ts";
import {
  calendarAction,
  calendarActionPromotionOptions,
} from "../../../../plugin-personal-assistant/src/actions/calendar.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import { retrieveContextualPlannerActions } from "./action-surface.ts";
import {
  collectBudgetedStageOneCandidateActions,
  collectPlannerTools,
} from "./planned-tool.ts";
import { createPlannerToolDiscoveryAction } from "./tool-discovery.ts";

const actions: Action[] = [
  ...promoteSubactionsToActions(triggerAction),
  ...promoteSubactionsToActions(calendarAction, calendarActionPromotionOptions),
];
const aliases = new Map(
  DEFAULT_CONTEXT_DEFINITIONS.map((context) => [context.id, context.aliases]),
);
const request = "actually make it 30 minutes";
// The captured Stage-1 plan: contexts ["general"], no candidate actions.
const intents = [
  "delete pending 20 minute stretch reminder",
  "set stretch reminder for 30 minutes from now",
];
const message = { content: { text: request } } as Memory;

/** The pipeline's initial selection when Stage 1 names no candidate. */
function initialSelection(text = request, stageOneIntents = intents) {
  return retrieveContextualPlannerActions({
    actions,
    deferUnscopedBootstrap: true,
    query: text,
    message: { content: { text } } as Memory,
    intents: stageOneIntents,
    contexts: ["general"],
    contextAliases: (context) => aliases.get(context),
  }).actions;
}

describe("a reminder edit Stage 1 phrases as delete and set again", () => {
  it("reaches the planner with TRIGGER_UPDATE beside TRIGGER_DELETE", () => {
    const selected = initialSelection();
    const names = selected.map((action) => action.name);
    expect(names).toEqual(
      expect.arrayContaining(["TRIGGER_DELETE", "TRIGGER_UPDATE"]),
    );
    // Only the delete's own sibling joins it, not every update in a family.
    expect(names).not.toContain("CALENDAR_UPDATE_PREFERENCES");
    const tools = collectPlannerTools(
      {
        events: [{ id: "trigger", type: "tool", tool: triggerAction }],
      } as ContextObject,
      selected,
      {
        canonicalFamilies: true,
        directActionNames: new Set(names),
      },
    );
    expect(
      tools.find((tool) => tool.name === "TRIGGER_UPDATE")?.parameters
        ?.required,
    ).toContain("taskId");
  });

  it("keeps the update when Stage 1 names the TRIGGER family", () => {
    const selectedActions = collectBudgetedStageOneCandidateActions({
      actions,
      candidateActions: ["TRIGGER"],
      contexts: ["tasks"],
      deferUnselectedContexts: true,
      deferParentHints: true,
      intents,
    });
    // The pipeline then fills uncovered domains around the hinted family.
    const filled = retrieveContextualPlannerActions({
      actions,
      query: request,
      intents,
      contexts: ["tasks"],
      selectedActions,
      directRouting: { rules: [], message },
      contextAliases: (context) => aliases.get(context),
    }).actions;
    expect(selectedActions.map((action) => action.name).sort()).toEqual([
      "TRIGGER_DELETE",
      "TRIGGER_UPDATE",
    ]);
    expect(filled.map((action) => action.name)).toEqual(
      expect.arrayContaining(["TRIGGER_DELETE", "TRIGGER_UPDATE"]),
    );
  });

  it("loads the update through an empty DISCOVER_ACTIONS call", async () => {
    let loaded: Action[] = [];
    const discovery = createPlannerToolDiscoveryAction(
      actions,
      (selected) => {
        loaded = selected;
      },
      async () => actions,
      { taskIntents: intents },
    );
    const result = await discovery.handler?.(
      {} as IAgentRuntime,
      message,
      undefined,
      { parameters: {} },
    );
    expect(result?.success).toBe(true);
    expect(loaded.map((action) => action.name)).toContain("TRIGGER_UPDATE");
  });

  it("leaves a plain delete without an update", () => {
    const names = initialSelection("delete my stretch reminder", [
      "delete the stretch reminder",
    ]).map((action) => action.name);
    expect(names).toContain("TRIGGER_DELETE");
    expect(names.filter((name) => name.includes("UPDATE"))).toEqual([]);
  });
});
