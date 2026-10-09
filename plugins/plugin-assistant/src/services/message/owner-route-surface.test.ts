/** Exercises plugin-owned replacement through real admission and native tool rendering. */
import {
  type Action,
  AgentRuntime,
  type Memory,
  promoteSubactionsToActions,
  registerDirectActionRoutingRule,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createOwnerReminderDirectRoutingRule } from "../../../../plugin-personal-assistant/src/lifeops/reminders/direct-routing";
import { collectV5PlannerCandidateActions } from "./action-surface";
import { collectPlannerTools } from "./planned-tool";

const text = "Remind me here to stretch my shoulders in two minutes.";
function surface(
  options: {
    unavailable?: boolean;
    group?: boolean;
    untagged?: boolean;
    noOwner?: boolean;
  } = {},
) {
  const runtime = new AgentRuntime({
    character: { name: "Routing", bio: [] },
    logLevel: "fatal",
  });
  const operation = [
    {
      name: "action",
      description: "Operation",
      required: true,
      schema: { type: "string", enum: ["create", "list", "update"] },
    },
  ];
  const owner: Action = {
    name: "OWNER_REMINDERS",
    description: "Owner reminders",
    contexts: ["tasks", "productivity"],
    roleGate: { minRole: "OWNER" },
    tags: options.untagged
      ? []
      : createOwnerReminderDirectRoutingRule().requiredActionTags.slice(),
    parameters: operation,
    validate: async (_runtime, message) =>
      !options.unavailable && message.content.channelType === "DM",
    handler: async () => ({ success: true }),
  };
  const trigger: Action = {
    name: "TRIGGER",
    description: "Generic automation",
    contexts: ["tasks", "automation"],
    roleGate: { minRole: "ADMIN" },
    parameters: operation,
    validate: async () => true,
    handler: async () => ({ success: true }),
  };
  runtime.actions = [
    ...(options.noOwner ? [] : promoteSubactionsToActions(owner)),
    ...promoteSubactionsToActions(trigger),
    {
      name: "OTHER_WORK",
      description: "Other work",
      contexts: ["tasks"],
      validate: async () => true,
      handler: async () => ({ success: true }),
    },
  ];
  registerDirectActionRoutingRule(
    runtime,
    createOwnerReminderDirectRoutingRule(),
  );
  return {
    runtime,
    message: {
      content: { text, channelType: options.group ? "GROUP" : "DM" },
    } as Memory,
    state: { text: "", values: {}, data: {} },
    selectedContexts: ["tasks" as const],
    candidateActions: ["OWNER_REMINDERS", "TRIGGER"],
    intents: ["create a 2-minute reminder to stretch shoulders in this room"],
    userRoles: ["OWNER" as const],
  };
}
function toolNames(actions: Action[]) {
  const context = {
    id: "authorized",
    events: actions.map((action) => ({
      id: action.name,
      type: "tool" as const,
      tool: { name: action.name, action },
    })),
  };
  return collectPlannerTools(context, actions, {
    canonicalFamilies: true,
    directActionNames: new Set(["OWNER_REMINDERS_CREATE", "TRIGGER_CREATE"]),
  }).map((tool) => tool.name);
}
describe("owner route survives fallback candidate seeding", () => {
  it.each([false, true])(
    "keeps reminder ownership during fresh discovery=%s",
    async (discoverActions) => {
      const actions = await collectV5PlannerCandidateActions({
        ...surface(),
        discoverActions,
      });
      const names = toolNames(actions);
      expect(names).toContain("OWNER_REMINDERS_CREATE");
      expect(names).not.toContain("TRIGGER");
      expect(names).not.toContain("TRIGGER_CREATE");
      expect(names).not.toContain("TRIGGER_UPDATE");
      expect(names).not.toContain("TRIGGER_LIST");
      expect(names).toContain("OTHER_WORK");
    },
  );
  it.each([
    { noOwner: true },
    { unavailable: true },
    { group: true },
    { untagged: true },
  ])(
    "keeps generic fallback when owner is not authoritative: %j",
    async (options) => {
      const names = toolNames(
        await collectV5PlannerCandidateActions(surface(options)),
      );
      expect(names).toContain("TRIGGER_CREATE");
    },
  );
  it("keeps generic automations when the owner intent does not match", async () => {
    const args = surface();
    args.message.content.text =
      "Every morning run the configured weather-fetch action.";
    args.candidateActions = ["TRIGGER"];
    args.intents = ["schedule the weather-fetch automation"];
    expect(toolNames(await collectV5PlannerCandidateActions(args))).toContain(
      "TRIGGER_CREATE",
    );
  });
  it("preserves explicit reminder plus independent automation outcomes", async () => {
    const args = surface();
    args.message.content.text =
      "Remind me here to stretch my shoulders in two minutes, and every morning run the configured weather-fetch action.";
    args.intents = [
      "create the shoulder-stretch reminder",
      "schedule the independent weather-fetch automation",
    ];
    const names = toolNames(await collectV5PlannerCandidateActions(args));
    expect(names).toContain("OWNER_REMINDERS_CREATE");
    expect(names).toContain("TRIGGER_CREATE");
  });
  it.each(["TRIGGER_UPDATE", "UPDATE_TRIGGER"])(
    "retains an explicitly selected sibling %s in an unsplit compound outcome",
    async (candidate) => {
      const args = surface();
      args.message.content.text =
        "Remind me here to stretch in two minutes and update my weather automation.";
      args.candidateActions = ["OWNER_REMINDERS", candidate];
      args.intents = [
        "create the shoulder reminder and update the independent weather automation",
      ];
      const names = toolNames(await collectV5PlannerCandidateActions(args));
      expect(names).toContain("OWNER_REMINDERS_CREATE");
      expect(names).toContain("TRIGGER_UPDATE");
    },
  );

  it("does not suppress an unrelated action with the fallback's prefix", async () => {
    const args = surface();
    args.runtime.actions.push({
      name: "TRIGGER_AUDIT",
      description: "Independent audit operation",
      contexts: ["tasks"],
      validate: async () => true,
      handler: async () => ({ success: true }),
    });
    expect(toolNames(await collectV5PlannerCandidateActions(args))).toContain(
      "TRIGGER_AUDIT",
    );
  });

  it("cannot use owner replacement to override actor gates", async () => {
    const args = surface();
    const names = toolNames(
      await collectV5PlannerCandidateActions({ ...args, userRoles: ["USER"] }),
    );
    expect(names).not.toContain("OWNER_REMINDERS_CREATE");
    expect(names).not.toContain("TRIGGER_CREATE");
  });
});
