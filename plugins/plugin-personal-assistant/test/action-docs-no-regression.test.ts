// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { allActionDocs } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { credentialsAction } from "../src/actions/credentials.ts";
import { ownerDocumentsAction } from "../src/actions/document.ts";
import {
  ownerRemindersAction,
  ownerTodosAction,
  personalAssistantAction,
} from "../src/actions/owner-surfaces.ts";
import { scheduledTaskAction } from "../src/actions/scheduled-task.ts";

/**
 * arch-audit #12092 item 29 — no-regression proof.
 *
 * These owner-surface actions are plugin-owned. Their docs used to be baked into
 * `@elizaos/core`'s generated action-docs aggregate as a fallback overlay. Item
 * 29 drops the plugin-owned rows from that aggregate so editing a plugin's
 * action docs no longer forces a core regen + rebuild.
 *
 * Dropping a row is only safe when the plugin's own Action object carries the
 * docs the fallback-only overlay used to supply. This test proves that property
 * directly from the real plugin Action objects: each carries its own
 * description (and parameters, where the overlay used to supply them), and none
 * is present in the core aggregate anymore — so the runtime overlay resolves
 * each action's docs from the Action object itself, unchanged.
 */
describe("owner-surface action docs resolve from the plugin, not the core aggregate", () => {
  const bakedNames = new Set(allActionDocs.map((doc) => doc.name));

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
    it(`${action.name} carries its own description and is absent from the core aggregate`, () => {
      expect(typeof action.description).toBe("string");
      expect(action.description.trim().length).toBeGreaterThan(0);
      expect(
        bakedNames.has(action.name),
        `${action.name} is plugin-owned and must not be baked into the core aggregate`,
      ).toBe(false);
    });
  }

  for (const action of actionsCarryingOwnParameters) {
    it(`${action.name} declares its own parameters (overlay no longer needed)`, () => {
      expect(Array.isArray(action.parameters)).toBe(true);
      expect(action.parameters?.length ?? 0).toBeGreaterThan(0);
    });
  }
});
