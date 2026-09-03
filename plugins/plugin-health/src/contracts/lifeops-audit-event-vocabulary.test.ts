/**
 * The LifeOps audit-event vocabulary is owned by `@elizaos/shared` and
 * re-exported here, per the policy this module's header states for the
 * passive-signal sources: one definition, not drifting copies.
 *
 * This file existed as a local 34-entry copy of a 44-entry canonical list —
 * missing `occurrence_progress_recorded` and the whole household-governance
 * block. Nothing imported the narrow copy (every consumer resolves
 * `LifeOpsAuditEventType` through `@elizaos/shared`), so the drift was silent.
 * These assertions fail if a local copy is reintroduced, or if the re-export is
 * pointed at anything but the canonical list.
 */

import { LIFEOPS_AUDIT_EVENT_TYPES as CANONICAL_AUDIT_EVENT_TYPES } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { LIFEOPS_AUDIT_EVENT_TYPES } from "./lifeops.js";

describe("LIFEOPS_AUDIT_EVENT_TYPES re-export", () => {
  it("is the canonical array, not a copy of it", () => {
    // Identity, not deep equality: a reintroduced local list with identical
    // contents would satisfy `toEqual` and drift again on the next edit.
    expect(LIFEOPS_AUDIT_EVENT_TYPES).toBe(CANONICAL_AUDIT_EVENT_TYPES);
  });

  it("carries every canonical event type in canonical order", () => {
    expect([...LIFEOPS_AUDIT_EVENT_TYPES]).toEqual([
      ...CANONICAL_AUDIT_EVENT_TYPES,
    ]);
  });

  /**
   * The eleven types the previous local copy omitted. Named explicitly so the
   * regression this file was added for is asserted by name, not only by length
   * — a future canonical addition changes the count but must not silently drop
   * any of these.
   */
  it.each([
    "occurrence_progress_recorded",
    "household_role_bound",
    "household_grant_issued",
    "household_grant_revoked",
    "household_proposal_created",
    "household_proposal_revised",
    "household_proposal_approved",
    "household_proposal_invalidated",
    "household_agreement_activated",
    "household_export_read",
  ])("includes the previously-missing %s event", (eventType: string) => {
    expect(LIFEOPS_AUDIT_EVENT_TYPES as readonly string[]).toContain(eventType);
  });

  it("still carries the two health-owned events the local copy did have", () => {
    expect(LIFEOPS_AUDIT_EVENT_TYPES as readonly string[]).toContain(
      "circadian_event_emitted",
    );
    expect(LIFEOPS_AUDIT_EVENT_TYPES as readonly string[]).toContain(
      "manual_override_accepted",
    );
  });

  it("lists no event type twice", () => {
    expect([...new Set(LIFEOPS_AUDIT_EVENT_TYPES)]).toEqual([
      ...LIFEOPS_AUDIT_EVENT_TYPES,
    ]);
  });
});
