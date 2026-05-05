import { describe, expect, it, vi } from "vitest";
import {
  createRelationshipsGraphIdentityObservationAdapter,
  ingestIdentityObservations,
  type LifeOpsIdentityObservation,
  type LifeOpsIdentityObservationCoreAdapter,
  LifeOpsIdentityObservationValidationError,
  normalizeIdentityHandle,
  normalizeIdentityObservation,
  normalizePhone,
  planIdentityObservationIngestion,
  plannerContextFromIdentityPlan,
} from "./identity-observations.js";

const NOW = "2026-05-03T12:00:00.000Z";

function provenance(
  source: LifeOpsIdentityObservation["provenance"]["source"],
  sourceId: string,
  observedAt = NOW,
): LifeOpsIdentityObservation["provenance"] {
  return {
    source,
    sourceId,
    observedAt,
    collectedAt: NOW,
    connectorAccountId: "owner@example.test",
  };
}

function gmail(
  sourceId: string,
  email: string,
  displayName: string,
): LifeOpsIdentityObservation {
  return {
    kind: "gmail_sender",
    email,
    displayName,
    provenance: provenance("gmail", sourceId),
    privacyScope: "owner_private",
  };
}

describe("LifeOps identity observation ingestion", () => {
  it("proposes one canonical graph merge for the same person across Gmail, phone, calendar, and chat", async () => {
    const proposeMerge = vi.fn(async () => "merge-candidate-1");
    const adapter = createRelationshipsGraphIdentityObservationAdapter({
      async getGraphSnapshot() {
        return {
          people: [
            {
              primaryEntityId: "person-gmail",
              displayName: "Sam from Gmail",
              emails: ["sam@example.test"],
              phones: [],
              identities: [],
            },
            {
              primaryEntityId: "person-phone",
              displayName: "Samantha Ko",
              emails: [],
              phones: ["+14155552671"],
              identities: [
                {
                  handles: [{ platform: "telegram", handle: "samantha" }],
                },
              ],
            },
          ],
        };
      },
      proposeMerge,
    });

    const result = await ingestIdentityObservations({
      core: adapter,
      options: { now: NOW },
      observations: [
        gmail("gmail-1", "Sam@Example.Test", "Sam"),
        {
          kind: "phone_contact",
          displayName: "Samantha Ko",
          emails: ["sam@example.test"],
          phones: ["(415) 555-2671"],
          handles: [{ platform: "telegram", handle: "@Samantha" }],
          provenance: provenance("phone_contacts", "contact-1"),
          privacyScope: "owner_private",
        },
        {
          kind: "calendar_attendee",
          email: "sam@example.test",
          displayName: "Samantha",
          eventId: "event-1",
          provenance: provenance("calendar", "event-1:attendee-1"),
          privacyScope: "owner_private",
        },
        {
          kind: "chat_identity",
          platform: "telegram",
          handle: "https://t.me/Samantha",
          displayName: "Samantha",
          provenance: provenance("chat", "telegram:123"),
          privacyScope: "owner_private",
        },
      ],
    });

    expect(result.proposedMerges).toHaveLength(1);
    expect(result.proposedMerges[0]).toMatchObject({
      entityA: "person-gmail",
      entityB: "person-phone",
      status: "proposed",
      requiresExplicitConfirmation: true,
      preferredDisplayName: "Samantha Ko",
    });
    expect(proposeMerge).toHaveBeenCalledWith(
      "person-gmail",
      "person-phone",
      expect.objectContaining({
        source: "lifeops.identity_observations",
        status: "proposed",
        requiresExplicitConfirmation: true,
      }),
    );
  });

  it("detects conflicting emails for the same display name and does not auto-merge them", async () => {
    const proposeMerge = vi.fn(async () => ({
      candidateId: "should-not-happen",
    }));
    const core: LifeOpsIdentityObservationCoreAdapter = {
      async findCandidatePeople() {
        return [
          { primaryEntityId: "alex-work", displayName: "Alex Lee" },
          { primaryEntityId: "alex-personal", displayName: "Alex Lee" },
        ];
      },
      proposeMerge,
    };

    const result = await ingestIdentityObservations({
      core,
      options: { now: NOW },
      observations: [
        gmail("gmail-work", "alex@work.example", "Alex Lee"),
        gmail("gmail-personal", "alex@personal.example", "Alex Lee"),
      ],
    });

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        type: "email_conflict",
        severity: "blocking",
        values: ["alex@personal.example", "alex@work.example"],
      }),
    ]);
    expect(result.proposedMerges).toHaveLength(0);
    expect(proposeMerge).not.toHaveBeenCalled();
  });

  it("lets verified manual assertions outrank weak Gmail sender display names", () => {
    const plan = planIdentityObservationIngestion(
      [
        gmail("gmail-weak-name", "sam@example.test", "Sammy Promo"),
        {
          kind: "manual_assertion",
          assertedBy: "owner",
          verified: true,
          assertedDisplayName: "Samantha Ko",
          assertedEmails: ["sam@example.test"],
          provenance: provenance("manual", "manual-sam"),
          privacyScope: "owner_private",
        },
      ],
      { now: NOW },
    );

    expect(plan.summaries).toHaveLength(1);
    expect(plan.summaries[0]?.displayName).toBe("Samantha Ko");
  });

  it("normalizes platform handles into stable canonical identity keys", () => {
    expect(
      normalizeIdentityHandle("X", "https://x.com/elizaOS_AI?lang=en"),
    ).toMatchObject({
      platform: "twitter",
      handle: "elizaos_ai",
    });
    expect(
      normalizeIdentityHandle("telegram-account", "@Samantha"),
    ).toMatchObject({
      platform: "telegram",
      handle: "samantha",
    });
    expect(normalizeIdentityHandle("Discord", "Samantha#0420")).toMatchObject({
      platform: "discord",
      handle: "samantha",
    });
  });

  it("normalizes phone numbers and rejects ambiguous local-only values", () => {
    expect(normalizePhone("(415) 555-2671")).toBe("+14155552671");
    expect(normalizePhone("+1 (415) 555-2671 ext. 22")).toBe("+14155552671");
    expect(normalizePhone("0044 20 7946 0018")).toBe("+442079460018");
    expect(normalizePhone("011 44 20 7946 0018")).toBe("+442079460018");
    expect(normalizePhone("555-2671")).toBeNull();
  });

  it("rejects observations without provenance", () => {
    expect(() =>
      normalizeIdentityObservation({
        kind: "gmail_sender",
        email: "missing-provenance@example.test",
        displayName: "Missing Provenance",
      } as LifeOpsIdentityObservation),
    ).toThrow(LifeOpsIdentityObservationValidationError);
  });

  it("withholds private and sensitive identities from planner context", () => {
    const plan = planIdentityObservationIngestion(
      [
        {
          kind: "manual_assertion",
          assertedBy: "owner",
          verified: true,
          assertedDisplayName: "Public Collaborator",
          assertedEmails: ["public@example.test"],
          provenance: provenance("manual", "planner-visible"),
          privacyScope: "planner_visible",
        },
        {
          kind: "phone_contact",
          displayName: "Sensitive Doctor",
          emails: ["doctor@example.test"],
          phones: ["415-555-7777"],
          provenance: provenance("phone_contacts", "sensitive-contact"),
          privacyScope: "sensitive",
        },
        {
          kind: "gmail_sender",
          displayName: "Private Friend",
          email: "private@example.test",
          provenance: provenance("gmail", "private-email"),
          privacyScope: "owner_private",
        },
      ],
      { now: NOW },
    );

    const plannerContext = plannerContextFromIdentityPlan(plan);

    expect(plannerContext.identities).toHaveLength(1);
    expect(plannerContext.identities[0]).toMatchObject({
      displayName: "Public Collaborator",
      emails: ["public@example.test"],
    });
    expect(JSON.stringify(plannerContext)).not.toContain("doctor@example.test");
    expect(JSON.stringify(plannerContext)).not.toContain(
      "private@example.test",
    );
  });

  it("collapses exact duplicate observations before planning", () => {
    const duplicate = gmail("gmail-duplicate", "dupe@example.test", "Dupe");
    const plan = planIdentityObservationIngestion([duplicate, duplicate], {
      now: NOW,
    });

    expect(plan.duplicateCount).toBe(1);
    expect(plan.normalizedObservations).toHaveLength(1);
  });

  it("decays stale observation confidence against the configured clock", () => {
    const fresh = normalizeIdentityObservation(
      gmail("fresh", "new@example.test", "New"),
      {
        now: NOW,
      },
    );
    const stale = normalizeIdentityObservation(
      {
        ...gmail("stale", "old@example.test", "Old"),
        provenance: provenance("gmail", "stale", "2024-05-03T12:00:00.000Z"),
      },
      { now: NOW },
    );

    expect(stale.confidence).toBeLessThan(fresh.confidence);
    expect(stale.confidenceDecay).toBeLessThan(fresh.confidenceDecay);
  });

  it("only proposes a core merge and never accepts it without explicit confirmation", async () => {
    const acceptMerge = vi.fn();
    const proposeMerge = vi.fn(async () => ({ candidateId: "candidate-2" }));
    const core = {
      async findCandidatePeople() {
        return [
          { primaryEntityId: "person-chat", displayName: "Samantha Chat" },
          { primaryEntityId: "person-phone", displayName: "Samantha Phone" },
        ];
      },
      proposeMerge,
      acceptMerge,
    };

    const result = await ingestIdentityObservations({
      core,
      options: { now: NOW },
      observations: [
        {
          kind: "phone_contact",
          displayName: "Samantha Ko",
          phones: ["(415) 555-2671"],
          handles: [{ platform: "telegram", handle: "@samantha" }],
          provenance: provenance("phone_contacts", "phone-sam"),
          privacyScope: "owner_private",
        },
        {
          kind: "chat_identity",
          platform: "telegram",
          handle: "@samantha",
          displayName: "Sam",
          provenance: provenance("chat", "chat-sam"),
          privacyScope: "owner_private",
        },
      ],
    });

    expect(result.proposedMerges).toHaveLength(1);
    expect(proposeMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "proposed",
        requiresExplicitConfirmation: true,
      }),
    );
    expect(acceptMerge).not.toHaveBeenCalled();
  });
});
