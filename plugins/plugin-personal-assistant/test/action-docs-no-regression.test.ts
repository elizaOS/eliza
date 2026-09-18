// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import { credentialsAction } from "../src/actions/credentials.ts";
import { ownerDocumentsAction } from "../src/actions/document.ts";
import {
  ownerRemindersAction,
  ownerTodosAction,
  personalAssistantAction,
} from "../src/actions/owner-surfaces.ts";
import { scheduledTaskAction } from "../src/actions/scheduled-task.ts";

/** Actions own the metadata consumed by the planner. */
describe("owner-surface action metadata", () => {
  const actionsCarryingOwnParameters = [
    scheduledTaskAction,
    credentialsAction,
    personalAssistantAction,
    ownerDocumentsAction,
  ];

  const actionsWithoutParameters = [ownerRemindersAction, ownerTodosAction];

  for (const action of [
    ...actionsCarryingOwnParameters,
    ...actionsWithoutParameters,
  ]) {
    it(`${action.name} carries its own description `, () => {
      expect(typeof action.description).toBe("string");
      expect(action.description.trim().length).toBeGreaterThan(0);
    });
  }

  for (const action of actionsCarryingOwnParameters) {
    it(`${action.name} declares its own parameters (overlay no longer needed)`, () => {
      expect(Array.isArray(action.parameters)).toBe(true);
      expect(action.parameters?.length ?? 0).toBeGreaterThan(0);
    });
  }
});
