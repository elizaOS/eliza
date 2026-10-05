import { promoteSubactionsToActions } from "@elizaos/core";
import { expect, it } from "vitest";
import {
  ownerAlarmsAction,
  ownerRemindersAction,
} from "../../../../plugin-personal-assistant/src/actions/owner-surfaces";
import { scheduledTaskAction } from "../../../../plugin-personal-assistant/src/actions/scheduled-task";
import { createHouseholdOperationsAction } from "../../../../plugin-personal-assistant/src/lifeops/household-operations/action";
import { preferredOperationNames } from "../../runtime/action-retrieval";
import { retrieveContextualPlannerActions } from "./action-surface";

const actions = [
  ...promoteSubactionsToActions(ownerRemindersAction),
  ...promoteSubactionsToActions(ownerAlarmsAction),
];

it("loads the requested resource for the captured reminder discovery query", () => {
  const result = retrieveContextualPlannerActions({
    actions,
    query: "create one-time reminder in-app notification",
  });
  expect(result.actions.map((action) => action.name)).toEqual([
    "OWNER_REMINDERS_CREATE",
  ]);
});

it.each([
  ["create reminders", ["OWNER_REMINDERS_CREATE"]],
  ["create an alarm titled 'reminder'", ["OWNER_ALARMS_CREATE"]],
  ["create an unknown item", ["OWNER_ALARMS_CREATE", "OWNER_REMINDERS_CREATE"]],
  [
    "create a reminder and an alarm",
    ["OWNER_ALARMS_CREATE", "OWNER_REMINDERS_CREATE"],
  ],
  [
    "if I have no reminder, create an alarm",
    ["OWNER_ALARMS_CREATE", "OWNER_REMINDERS_CREATE"],
  ],
  [
    "create an item named alarm.json",
    ["OWNER_ALARMS_CREATE", "OWNER_REMINDERS_CREATE"],
  ],
])("preserves resource and fallback semantics for %s", (query, expected) => {
  const result = retrieveContextualPlannerActions({ actions, query });
  expect(result.actions.map((action) => action.name).sort()).toEqual(expected);
});

it("retains an unresolved second intent and explicit selected operations", () => {
  const alarm = actions.find((action) => action.name === "OWNER_ALARMS_CREATE");
  if (!alarm) throw new Error("Missing registered alarm create operation");
  const result = retrieveContextualPlannerActions({
    actions,
    query: "create a reminder",
    intents: ["create a reminder", "create an unknown item"],
  });
  expect(result.actions.map((action) => action.name).sort()).toEqual([
    "OWNER_ALARMS_CREATE",
    "OWNER_REMINDERS_CREATE",
  ]);
  const required = retrieveContextualPlannerActions({
    actions,
    query: "create a reminder",
    selectedActions: [alarm],
  });
  expect(required.actions.map((action) => action.name)).toContain(alarm.name);
});

it("keeps context-only discovery membership unchanged", () => {
  const result = retrieveContextualPlannerActions({
    actions,
    query: "",
    contexts: ["tasks"],
  });
  expect(result.matchCount).toBe(actions.length);
});

it("does not erase a second operation whose resource wording is unknown", () => {
  const read = {
    name: "FILE_READ",
    description: "Read a document",
    contexts: ["files"],
  };
  const result = retrieveContextualPlannerActions({
    actions: [...actions, read],
    query: "create a reminder read a document",
  });
  expect(result.actions.map((action) => action.name)).toContain(read.name);
});

it("loads only reminder creation for the actual scheduled-reminder intent", () => {
  const result = retrieveContextualPlannerActions({
    actions,
    query: "Remind me here to stretch my shoulders in two minutes.",
    intents: [
      "schedule a one-time reminder for the user in two minutes to stretch their shoulders in this room",
    ],
    contexts: ["todos", "tasks", "productivity"],
  });
  expect(result.actions.map((action) => action.name)).toEqual([
    "OWNER_REMINDERS_CREATE",
  ]);
});

it("keeps household operations out of the captured standalone reminder request", () => {
  const household = createHouseholdOperationsAction({
    authorize: async () => true,
  });
  const result = retrieveContextualPlannerActions({
    actions: [...actions, household],
    query: "Remind me here to stretch my shoulders in two minutes.",
    intents: [
      "create a reminder to stretch shoulders in two minutes in this room",
    ],
    contexts: ["general", "tasks", "productivity"],
  });
  expect(result.actions.map((action) => action.name)).toEqual([
    "OWNER_REMINDERS_CREATE",
  ]);
});

it("retains explicit household discovery and task-context admission", () => {
  const household = createHouseholdOperationsAction({
    authorize: async () => true,
  });
  expect(household.contexts).toContain("tasks");
  for (const query of [
    "HOUSEHOLD_OPERATIONS",
    "record household maintenance observations",
  ]) {
    const result = retrieveContextualPlannerActions({
      actions: [...actions, household],
      query,
      contexts: ["tasks"],
    });
    expect(result.actions).toContain(household);
  }
});

it("loads reminder creation for the captured one-shot set intent", () => {
  const result = retrieveContextualPlannerActions({
    actions: [...actions, ...promoteSubactionsToActions(scheduledTaskAction)],
    query: "Remind me here to stretch my shoulders in two minutes.",
    intents: [
      "Set a one-shot reminder about two minutes ahead to remind the user to stretch their shoulders in this chat",
    ],
    contexts: ["general", "tasks", "productivity"],
  });
  expect(result.actions.map((action) => action.name)).toEqual([
    "OWNER_REMINDERS_CREATE",
  ]);
});

it.each([
  ["schedule a reminder", ["OWNER_REMINDERS_CREATE"]],
  ["read my reminder schedule", ["OWNER_REMINDERS_LIST"]],
  ["update the reminder schedule", ["OWNER_REMINDERS_UPDATE"]],
  ["reschedule the reminder", []],
  ["explain how to schedule a reminder", []],
  ["set a reminder for noon", ["OWNER_REMINDERS_CREATE"]],
  ["set a one-shot reminder for noon", ["OWNER_REMINDERS_CREATE"]],
  ["set the reminder message to hello", []],
  ["set a reminder's message to hello", []],
  ["set a reminder message to hello", []],
  ["set my timezone", []],
  ["explain how to set a reminder", []],
])("keeps schedule operation meaning for %s", (query, expected) => {
  expect([
    ...preferredOperationNames(query, [
      "OWNER_REMINDERS_CREATE",
      "OWNER_REMINDERS_LIST",
      "OWNER_REMINDERS_UPDATE",
    ]),
  ]).toEqual(expected);
});
