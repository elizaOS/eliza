/** Initial exposure honors admitted direct-route coverage without hiding discovery. */
import type { Action, DirectActionRoutingRule, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { briefAction } from "../../../../plugin-personal-assistant/src/actions/brief.ts";
import { ownerRoutinesAction } from "../../../../plugin-personal-assistant/src/actions/owner-surfaces.ts";
import { scheduledTaskAction } from "../../../../plugin-personal-assistant/src/actions/scheduled-task.ts";
import { createTrackedWorkRecapDirectRoutingRule } from "../../../../plugin-personal-assistant/src/lifeops/briefing/direct-routing.ts";
import { retrieveContextualPlannerActions } from "./action-surface.ts";

const request =
  "Give me my daily dossier using the connected sources available now.";
const intent =
  "Compile the daily dossier using connected sources available now";
const rule = createTrackedWorkRecapDirectRoutingRule();
const actions = [briefAction, ownerRoutinesAction, scheduledTaskAction];
function select(
  options: {
    request?: string;
    intents?: string[];
    selected?: Action[];
    available?: Action[];
    rules?: DirectActionRoutingRule[];
  } = {},
) {
  const intents = options.intents ?? [intent];
  return retrieveContextualPlannerActions({
    actions: options.available ?? actions,
    query: intents.join("\n"),
    intents,
    contexts: ["productivity", "tasks"],
    selectedActions: options.selected ?? [briefAction],
    contextAliases: (context) =>
      context === "productivity" ? ["briefing", "dossier"] : [],
    directRouting: {
      rules: options.rules ?? [rule],
      message: { content: { text: options.request ?? request } } as Memory,
    },
  }).actions.map((action) => action.name);
}

describe("admitted direct-route bootstrap coverage", () => {
  it("keeps captured request 448 on its sole admitted BRIEF candidate", () => {
    expect(select()).toEqual(["BRIEF"]);
  });
  it("retains the wider bootstrap without a matching registered route", () => {
    expect(select({ rules: [] })).toContain("SCHEDULED_TASKS");
    expect(select({ request: "What tasks need attention?" })).toContain(
      "SCHEDULED_TASKS",
    );
  });
  it("does not infer route ownership from an action name with wrong tags", () => {
    const wrong = { ...briefAction, tags: ["domain:other"] };
    expect(
      select({
        available: [wrong, ownerRoutinesAction, scheduledTaskAction],
        selected: [wrong],
      }),
    ).toContain("SCHEDULED_TASKS");
  });
  it("does not restore an owner excluded by admission gates", () => {
    const selected = select({
      available: [ownerRoutinesAction, scheduledTaskAction],
      selected: [],
    });
    expect(selected).not.toContain("BRIEF");
    expect(selected).toContain("SCHEDULED_TASKS");
  });
  it("preserves an explicit independent selected operation", () => {
    expect(select({ selected: [briefAction, scheduledTaskAction] })).toContain(
      "SCHEDULED_TASKS",
    );
  });
  it.each([
    [
      "Give me my daily dossier and snooze the reminder.",
      [intent, "Snooze the reminder"],
    ],
    [
      "Give me my daily dossier and snooze the reminder.",
      ["Compile the daily dossier and snooze the reminder"],
    ],
    [request, [intent, "Snooze the reminder"]],
  ])("retains uncovered or compound work: %s", (text, intents) => {
    expect(select({ request: text, intents })).toContain("SCHEDULED_TASKS");
  });
  it.each([
    [
      "Give me my daily dossier. Snooze the reminder.",
      ["Compile the daily dossier. Snooze the reminder"],
    ],
    [
      "Give me my daily dossier\nSnooze the reminder",
      ["Compile the daily dossier\nSnooze the reminder"],
    ],
    [
      "Give me my daily dossier but snooze the reminder",
      ["Compile the daily dossier but snooze the reminder"],
    ],
    [
      "Give me my daily dossier: snooze the reminder",
      ["Compile the daily dossier: snooze the reminder"],
    ],
    [
      "Give me my daily dossier & snooze the reminder",
      ["Compile the daily dossier & snooze the reminder"],
    ],
    [request, ["Snooze the reminder"]],
  ])(
    "preserves the existing bootstrap for mismatched or multi-clause intent: %s",
    (text, intents) => {
      const withoutCoverage = select({ request: text, intents, rules: [] });
      expect(withoutCoverage).toContain("SCHEDULED_TASKS");
      expect(select({ request: text, intents })).toEqual(withoutCoverage);
    },
  );
  it("preserves a domain outside the matched rule's declared coverage", () => {
    const calendar: Action = {
      name: "CALENDAR_READ",
      contexts: ["calendar"],
      tags: ["domain:calendar"],
      description: "Read the calendar",
    };
    const selection = retrieveContextualPlannerActions({
      actions: [...actions, calendar],
      query: intent,
      intents: [intent],
      contexts: ["tasks", "calendar"],
      selectedActions: [briefAction],
      directRouting: {
        rules: [rule],
        message: { content: { text: request } } as Memory,
      },
    });
    expect(selection.actions.map((action) => action.name)).toContain(
      "CALENDAR_READ",
    );
  });
  it("uses the same declared contract for an unrelated registered route", () => {
    const digest: Action = {
      name: "INCIDENT_DIGEST",
      contexts: ["logs"],
      tags: ["domain:incident-summary", "capability:read"],
      description: "Compose incident summary",
    };
    const logs: Action = {
      name: "LOGS_READ",
      contexts: ["logs"],
      tags: ["domain:logs"],
      description: "Read incident logs",
    };
    const selection = retrieveContextualPlannerActions({
      actions: [digest, logs],
      query: "Compose the incident summary",
      intents: ["Compose the incident summary"],
      contexts: ["logs"],
      selectedActions: [digest],
      directRouting: {
        rules: [
          {
            id: "test.incident-summary",
            actionNames: [digest.name],
            requiredActionTags: ["domain:incident-summary", "capability:read"],
            contexts: ["logs"],
            matches: (text) => text === "Compose the incident summary",
          },
        ],
        message: {
          content: { text: "Compose the incident summary" },
        } as Memory,
      },
    });
    expect(selection.actions.map((action) => action.name)).toEqual([
      digest.name,
    ]);
  });
});
