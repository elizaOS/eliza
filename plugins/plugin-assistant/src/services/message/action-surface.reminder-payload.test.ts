/** Captured535: reminder content must not invent a separate phone operation. */
import {
  type Action,
  AgentRuntime,
  type ContextObject,
  ContextRegistry,
  type Memory,
  promoteSubactionsToActions,
  registerDirectActionRoutingRule,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { pageDelegateAction } from "../../../../../packages/agent/src/actions/page-action-groups.ts";
import { ownerRemindersAction } from "../../../../plugin-personal-assistant/src/actions/owner-surfaces.ts";
import { voiceCallAction } from "../../../../plugin-personal-assistant/src/actions/voice-call.ts";
import { createOwnerReminderDirectRoutingRule } from "../../../../plugin-personal-assistant/src/lifeops/reminders/direct-routing.ts";
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

const request = "Remind me here in one minute to finish the final phone check.";
const intent =
  "Set a reminder to ping the user in one minute to finish the final phone check";

async function surface(
  options: {
    request?: string;
    intents?: string[];
    contexts?: string[];
    candidates?: string[];
    noRule?: boolean;
    wrongTags?: boolean;
    denyOwner?: boolean;
  } = {},
) {
  const runtime = new AgentRuntime({
    character: { name: "Reminder payload", bio: [] },
    logLevel: "fatal",
  });
  runtime.contexts = new ContextRegistry([...DEFAULT_CONTEXT_DEFINITIONS]);
  // Real action validation reads room scope; no database or effect is needed.
  vi.spyOn(runtime, "getRoom").mockResolvedValue(undefined);
  const owner: Action = {
    ...ownerRemindersAction,
    ...(options.wrongTags ? { tags: [] } : {}),
    ...(options.denyOwner ? { validate: async () => false } : {}),
  };
  for (const action of [
    ...promoteSubactionsToActions(owner),
    pageDelegateAction,
    voiceCallAction,
  ])
    runtime.registerAction(action);
  const rule = createOwnerReminderDirectRoutingRule();
  if (!options.noRule) registerDirectActionRoutingRule(runtime, rule);
  const message = {
    id: stringToUuid("reminder-payload-message"),
    agentId: runtime.agentId,
    entityId: stringToUuid("reminder-payload-owner"),
    roomId: stringToUuid("reminder-payload-room"),
    content: { text: options.request ?? request, channelType: "DM" },
  } as Memory;
  const contexts = options.contexts ?? ["general", "tasks", "productivity"];
  const intents = options.intents ?? [intent];
  const candidates = options.candidates ?? ["OWNER_REMINDERS", "TRIGGER"];
  const admitted = await collectV5PlannerCandidateActions({
    runtime,
    message,
    state: { text: "", values: {}, data: {} },
    selectedContexts: contexts,
    candidateActions: candidates,
    intents,
    userRoles: ["OWNER"],
  });
  const selected = collectBudgetedStageOneCandidateActions({
    actions: admitted,
    candidateActions: candidates,
    contexts,
    deferUnselectedContexts: true,
    deferParentHints: true,
    intents,
  });
  const discovery = createPlannerToolDiscoveryAction(
    admitted,
    () => {},
    async () => admitted,
  );
  const context = {
    events: [{ id: "reminder", type: "tool", tool: owner }],
  } as ContextObject;
  const build = (rules: (typeof rule)[]) => {
    const result = retrieveContextualPlannerActions({
      actions: admitted,
      selectedActions: selected,
      query: intents.join("\n"),
      intents,
      contexts,
      contextAliases: (id) => runtime.contexts.get(id)?.aliases,
      directRouting: { rules, message },
    });
    expect(result.actions.every((action) => admitted.includes(action))).toBe(
      true,
    );
    return collectPlannerTools(context, [...result.actions, discovery], {
      canonicalFamilies: true,
      directActionNames: new Set(selected.map((action) => action.name)),
    });
  };
  return {
    admitted,
    selected,
    tools: build(options.noRule ? [] : [rule]),
    baselineTools: build([]),
  };
}

describe("registered owner distinguishes reminder payload from phone work", () => {
  it("keeps the captured final phone check on its complete reminder schema", async () => {
    const result = await surface();
    expect(result.selected.map((action) => action.name)).toEqual([
      "OWNER_REMINDERS_CREATE",
    ]);
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "DISCOVER_ACTIONS",
      "IGNORE",
      "OWNER_REMINDERS_CREATE",
      "REPLY",
      "STOP",
    ]);
    expect(
      result.tools.find((tool) => tool.name === "OWNER_REMINDERS_CREATE"),
    ).toEqual(
      result.baselineTools.find(
        (tool) => tool.name === "OWNER_REMINDERS_CREATE",
      ),
    );
    expect(result.admitted.map((action) => action.name)).toEqual(
      expect.arrayContaining(["PAGE_DELEGATE", "VOICE_CALL"]),
    );
  });

  it.each([
    "Remind me here in one minute to finish the final phone check and call my phone now.",
    "Call my phone now and remind me here in one minute to finish the final phone check.",
    "Remind me here in one minute. Call my phone now.",
    "Remind me here in one minute; call my phone now.",
  ])("retains independent phone work: %s", async (text) => {
    const result = await surface({ request: text, intents: [text] });
    expect(result.tools).toEqual(result.baselineTools);
    expect(result.tools.map((tool) => tool.name)).toContain("VOICE_CALL");
  });

  it.each([
    { contexts: ["general", "tasks", "productivity", "phone"] },
    { candidates: ["OWNER_REMINDERS", "PAGE_DELEGATE", "VOICE_CALL"] },
    { noRule: true },
    { wrongTags: true },
  ])("preserves declared work or unproven ownership: %j", async (options) => {
    const result = await surface(options);
    expect(result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["PAGE_DELEGATE", "VOICE_CALL"]),
    );
  });

  it("does not narrow an intent that differs from the registered request", async () => {
    const result = await surface({ intents: ["Call my phone now"] });
    expect(result.tools).toEqual(result.baselineTools);
  });

  it("does not restore a rejected owner through direct routing", async () => {
    const result = await surface({ denyOwner: true });
    expect(result.tools.map((tool) => tool.name)).not.toContain(
      "OWNER_REMINDERS_CREATE",
    );
    expect(result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["PAGE_DELEGATE", "VOICE_CALL"]),
    );
  });
});
