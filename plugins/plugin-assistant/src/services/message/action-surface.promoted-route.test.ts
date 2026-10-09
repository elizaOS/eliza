/** Live467-shaped pipeline: registered promotion, admission, candidate families and emitted tools. */
import { mkdir, writeFile } from "node:fs/promises";
import {
  type Action,
  AgentRuntime,
  type ContextObject,
  ContextRegistry,
  type Memory,
  promoteSubactionsToActions,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { testOutputPath } from "../../../../../packages/scripts/lib/test-output.ts";
import { briefAction } from "../../../../plugin-personal-assistant/src/actions/brief.ts";
import { ownerRoutinesAction } from "../../../../plugin-personal-assistant/src/actions/owner-surfaces.ts";
import { scheduledTaskAction } from "../../../../plugin-personal-assistant/src/actions/scheduled-task.ts";
import { createTrackedWorkRecapDirectRoutingRule } from "../../../../plugin-personal-assistant/src/lifeops/briefing/direct-routing.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import {
  collectV5PlannerCandidateActions,
  retrieveContextualPlannerActions,
} from "./action-surface.ts";
import {
  collectBudgetedStageOneCandidateActions,
  collectPlannerTools,
} from "./planned-tool.ts";
import { createPlannerToolDiscoveryAction } from "./tool-discovery.ts";

const text =
  "Give me my daily dossier using the connected sources available now.";
const contexts = ["productivity", "tasks"];

async function admittedFixture() {
  const runtime = new AgentRuntime({
    character: { name: "Promoted route", bio: [] },
    logLevel: "fatal",
  });
  runtime.contexts = new ContextRegistry([...DEFAULT_CONTEXT_DEFINITIONS]);
  const parent = {
    ...briefAction,
    subActions: undefined,
    validate: async () => true,
  };
  const family = promoteSubactionsToActions(parent);
  for (const action of [
    ...family,
    { ...ownerRoutinesAction, validate: async () => true },
    { ...scheduledTaskAction, validate: async () => true },
  ])
    runtime.registerAction(action);
  const message: Memory = {
    id: stringToUuid("promoted-route"),
    agentId: runtime.agentId,
    roomId: stringToUuid("promoted-room"),
    entityId: stringToUuid("promoted-owner"),
    createdAt: 1000,
    content: { text },
  };
  const admitted = await collectV5PlannerCandidateActions({
    runtime,
    message,
    state: { text: "", values: {}, data: {} },
    selectedContexts: contexts,
    candidateActions: ["BRIEF"],
    intents: [text],
    userRoles: ["OWNER"],
  });
  const selected = collectBudgetedStageOneCandidateActions({
    actions: admitted,
    candidateActions: ["BRIEF"],
    contexts,
    deferUnselectedContexts: true,
    deferParentHints: true,
    intents: [text],
  });
  return { runtime, message, parent, family, admitted, selected };
}

describe("promoted direct-route family coverage", () => {
  it("keeps live467's promoted BRIEF family without bootstrapping other domains", async () => {
    const f = await admittedFixture();
    expect(f.family.length).toBeGreaterThan(1);
    expect(f.selected.map((action) => action.name)).toEqual(
      f.family.map((action) => action.name),
    );
    expect(f.selected.every((action) => f.admitted.includes(action))).toBe(
      true,
    );
    const selection = retrieveContextualPlannerActions({
      actions: f.admitted,
      selectedActions: f.selected,
      query: text,
      intents: [text],
      contexts,
      directRouting: {
        rules: [createTrackedWorkRecapDirectRoutingRule()],
        message: f.message,
      },
      contextAliases: (context) => f.runtime.contexts.get(context)?.aliases,
    });
    expect(selection.actions.map((action) => action.name)).toEqual(
      f.family.map((action) => action.name),
    );
    const discovery = createPlannerToolDiscoveryAction(
      f.admitted,
      () => {},
      async () => f.admitted,
    );
    const tools = collectPlannerTools(
      {
        events: [{ id: "brief", type: "tool", tool: f.parent }],
      } as ContextObject,
      [...selection.actions, discovery],
      { canonicalFamilies: true, directActionNames: new Set(["BRIEF"]) },
    );
    const output = testOutputPath("assistant-promoted-route");
    await mkdir(output, { recursive: true });
    await writeFile(
      testOutputPath("assistant-promoted-route", "planner-tools.json"),
      JSON.stringify(
        {
          request: text,
          admittedNames: f.admitted.map((action) => action.name),
          selectedNames: f.selected.map((action) => action.name),
          selectedObjectsAreAdmitted: f.selected.every((action) =>
            f.admitted.includes(action),
          ),
          finalSelectedNames: selection.actions.map((action) => action.name),
          tools,
        },
        null,
        2,
      ),
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      "BRIEF",
      "DISCOVER_ACTIONS",
      "IGNORE",
      "REPLY",
      "STOP",
    ]);
  });

  it("does not treat a prefix-shaped unrelated action as a registered family member", async () => {
    const f = await admittedFixture();
    const fake: Action = {
      ...f.parent,
      name: "BRIEF_UNRELATED",
      subActions: undefined,
    };
    const selection = retrieveContextualPlannerActions({
      actions: [...f.admitted, fake],
      selectedActions: [...f.selected, fake],
      query: text,
      intents: [text],
      contexts,
      directRouting: {
        rules: [createTrackedWorkRecapDirectRoutingRule()],
        message: f.message,
      },
    });
    expect(selection.actions.map((action) => action.name)).toContain(
      "SCHEDULED_TASKS",
    );
  });

  it("cannot use a family declaration without its admitted owner", async () => {
    const f = await admittedFixture();
    const selection = retrieveContextualPlannerActions({
      actions: f.admitted.filter((action) => action !== f.parent),
      selectedActions: f.selected.filter((action) => action !== f.parent),
      query: text,
      intents: [text],
      contexts,
      directRouting: {
        rules: [createTrackedWorkRecapDirectRoutingRule()],
        message: f.message,
      },
    });
    expect(selection.actions.map((action) => action.name)).toContain(
      "SCHEDULED_TASKS",
    );
  });

  it.each(["unadmitted", "wrong-tag"])(
    "does not accept a %s child through family membership",
    async (mode) => {
      const f = await admittedFixture();
      const child = f.family[1];
      if (!child) throw new Error("Promoted child missing");
      const replacement = mode === "wrong-tag" ? { ...child, tags: [] } : child;
      const admitted = f.admitted.flatMap((action) =>
        action !== child
          ? [action]
          : mode === "unadmitted"
            ? []
            : [replacement],
      );
      const selected = f.selected.map((action) =>
        action === child ? replacement : action,
      );
      const selection = retrieveContextualPlannerActions({
        actions: admitted,
        selectedActions: selected,
        query: text,
        intents: [text],
        contexts,
        directRouting: {
          rules: [createTrackedWorkRecapDirectRoutingRule()],
          message: f.message,
        },
      });
      expect(selection.actions.map((action) => action.name)).toContain(
        "SCHEDULED_TASKS",
      );
    },
  );

  it("preserves independent work beside a promoted family", async () => {
    const f = await admittedFixture();
    const request = `${text} Snooze the reminder.`;
    const selection = retrieveContextualPlannerActions({
      actions: f.admitted,
      selectedActions: f.selected,
      query: request,
      intents: [text, "Snooze the reminder"],
      contexts,
      directRouting: {
        rules: [createTrackedWorkRecapDirectRoutingRule()],
        message: { ...f.message, content: { text: request } },
      },
    });
    expect(selection.actions.map((action) => action.name)).toContain(
      "SCHEDULED_TASKS",
    );
  });
});
