import { promoteSubactionsToActions } from "@elizaos/core";
import { expect, it } from "vitest";
import {
  ownerAlarmsAction,
  ownerRemindersAction,
} from "../../../../plugin-personal-assistant/src/actions/owner-surfaces";
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
