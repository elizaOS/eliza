import type { Action } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import {
  inferActionSearchContexts,
  retrieveContextualPlannerActions,
} from "./action-surface.ts";

describe("reminder and alarm domain tool search (issue #37043)", () => {
  const reminderDefinition = DEFAULT_CONTEXT_DEFINITIONS.find(
    (c) => c.id === "reminders",
  );

  const getAlias = (contextId: string) => {
    if (contextId === "reminders") return reminderDefinition?.aliases;
    return undefined;
  };

  const ownerReminders: Action = {
    name: "OWNER_REMINDERS",
    contexts: ["general", "tasks", "reminders"],
    description: "Owner reminders: create/update/cancel/delete one-off and recurring reminders.",
  };

  const ownerAlarms: Action = {
    name: "OWNER_ALARMS",
    contexts: ["general", "tasks", "reminders"],
    description: "Owner alarms: create/update/delete alarm reminders.",
  };

  const generalAction: Action = {
    name: "CHAT_REPLY",
    contexts: ["general"],
    description: "General chat reply.",
  };

  const actions = [generalAction, ownerReminders, ownerAlarms];

  it("declares reminders context in DEFAULT_CONTEXT_DEFINITIONS with required aliases", () => {
    expect(reminderDefinition).toBeDefined();
    expect(reminderDefinition?.id).toBe("reminders");
    expect(reminderDefinition?.aliases).toContain("reminder");
    expect(reminderDefinition?.aliases).toContain("alarm");
    expect(reminderDefinition?.aliases).toContain("alarms");
  });

  it.each([
    ["drop the vet reminder", ["reminders"]],
    ["remind me to call the vet in 50 minutes", ["reminders"]],
    ["turn off my morning alarm", ["reminders"]],
    ["list all alarms", ["reminders"]],
    ["what reminders are set", ["reminders"]],
  ])("infers reminders domain from intent %s", (query, expected) => {
    const inferred = inferActionSearchContexts(actions, query, getAlias);
    expect(inferred).toEqual(expected);
  });

  it("loads OWNER_REMINDERS when Stage 1 routes to general with a reminder intent", () => {
    const result = retrieveContextualPlannerActions({
      actions,
      query: "drop the vet reminder",
      intents: ["drop the vet reminder"],
      contexts: ["general"],
      contextAliases: getAlias,
    });

    const actionNames = result.actions.map((a) => a.name);
    expect(actionNames).toContain("OWNER_REMINDERS");
  });

  it("loads OWNER_ALARMS when Stage 1 routes to simple with an alarm intent", () => {
    const result = retrieveContextualPlannerActions({
      actions,
      query: "turn off the alarm",
      intents: ["turn off the alarm"],
      contexts: ["simple"],
      contextAliases: getAlias,
    });

    const actionNames = result.actions.map((a) => a.name);
    expect(actionNames).toContain("OWNER_ALARMS");
  });
});
