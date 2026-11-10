/**
 * Plugin wiring: the follow-up actions are registered under their own names,
 * and the inbox triage pack is offered rather than seeded at boot.
 */
import { describe, expect, it } from "vitest";
import { scheduledTaskAction } from "./actions/scheduled-task.js";
import type { ConnectorRegistryContract } from "./default-packs/contract-types.js";
import {
  INBOX_TRIAGE_STARTER_PACK_KEY,
  isInboxTriageEligible,
} from "./default-packs/inbox-triage-starter.js";
import { buildDefaultPackCatalogTasks } from "./default-packs/spine-registration.js";
import { personalAssistantPlugin } from "./index";

const FOLLOWUP_ACTION_NAMES = [
  "LIST_OVERDUE_FOLLOWUPS",
  "MARK_FOLLOWUP_DONE",
  "SET_FOLLOWUP_THRESHOLD",
];

describe("personal-assistant plugin wiring", () => {
  it("registers the follow-up actions under their own names", () => {
    const names = (personalAssistantPlugin.actions ?? []).map(
      (action) => action.name,
    );
    for (const name of FOLLOWUP_ACTION_NAMES) {
      expect(names).toContain(name);
    }
    // SCHEDULED_TASKS cannot write follow-up state, so it must not claim
    // these names as similes.
    for (const name of FOLLOWUP_ACTION_NAMES) {
      expect(scheduledTaskAction.similes ?? []).not.toContain(name);
    }
  });

  it("does not seed the inbox triage pack at boot", () => {
    const keys = buildDefaultPackCatalogTasks().map(
      (task) => task.idempotencyKey ?? "",
    );
    expect(
      keys.some((key) => key.includes(INBOX_TRIAGE_STARTER_PACK_KEY)),
    ).toBe(false);
  });

  it("gates the inbox triage pack on the capability the Google connector declares", () => {
    const registryWith = (capability: string) =>
      ({
        byCapability: (requested: string) =>
          requested === capability ? [{ kind: "google" }] : [],
      }) as unknown as ConnectorRegistryContract;
    expect(isInboxTriageEligible(registryWith("google.gmail.triage"))).toBe(
      true,
    );
    expect(isInboxTriageEligible(registryWith("google.gmail.read"))).toBe(
      false,
    );
  });
});
