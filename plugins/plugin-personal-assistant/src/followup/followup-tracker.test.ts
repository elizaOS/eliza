/**
 * Follow-up tracker tests for passive contact recency. The production tracker
 * reads the RelationshipsService contact projection, so these cases pin the
 * fields updated by real message ingestion rather than only manual actions.
 */
import type { IAgentRuntime, JsonValue, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type ContactInfo,
  computeOverdueFollowups,
} from "./followup-tracker.js";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");

function contact(
  overrides: Partial<ContactInfo> & { entityId: UUID },
): ContactInfo {
  return {
    categories: [],
    tags: [],
    customFields: {},
    ...overrides,
  };
}

function runtimeWithContacts(contacts: ContactInfo[]): IAgentRuntime {
  const service = {
    searchContacts: vi.fn(async () => contacts),
    getContact: vi.fn(
      async (entityId: UUID) =>
        contacts.find((entry) => entry.entityId === entityId) ?? null,
    ),
    updateContact: vi.fn(),
  };
  return {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getService: vi.fn((name: string) =>
      name === "relationships" ? service : null,
    ),
    getEntityById: vi.fn(async (entityId: UUID) => ({
      names: [
        String(
          contacts.find((entry) => entry.entityId === entityId)?.customFields
            .displayName ?? entityId,
        ),
      ],
    })),
  } as unknown as IAgentRuntime;
}

describe("computeOverdueFollowups passive recency", () => {
  it("uses RelationshipsService lastInteractionAt written by real message ingestion", async () => {
    const runtime = runtimeWithContacts([
      contact({
        entityId: "10000000-0000-0000-0000-000000000001" as UUID,
        customFields: {
          displayName: "Priya",
          lastContactedAt: "2026-04-01T12:00:00.000Z" as JsonValue,
        },
        lastInteractionAt: "2026-05-31T12:00:00.000Z",
      }),
    ]);

    const digest = await computeOverdueFollowups(runtime, NOW, 30);

    expect(digest.overdue).toEqual([]);
  });

  it("learns cadence from observed interaction intervals when no override exists", async () => {
    const runtime = runtimeWithContacts([
      contact({
        entityId: "10000000-0000-0000-0000-000000000002" as UUID,
        customFields: { displayName: "Morgan" },
        lastInteractionAt: "2026-05-21T12:00:00.000Z",
        interactions: [
          { occurredAt: "2026-05-07T12:00:00.000Z" },
          { occurredAt: "2026-05-14T12:00:00.000Z" },
          { occurredAt: "2026-05-21T12:00:00.000Z" },
        ],
      }),
    ]);

    const digest = await computeOverdueFollowups(runtime, NOW, 30);

    expect(digest.overdue).toHaveLength(1);
    expect(digest.overdue[0]).toMatchObject({
      displayName: "Morgan",
      thresholdDays: 7,
      daysOverdue: 4,
    });
  });

  it("uses the statistical median (not the temporal-middle gap) for irregular cadence", async () => {
    // Chronological interaction gaps are [1d, 30d, 2d]. The gaps array derived
    // from time-sorted interactions is itself in temporal order, so the middle
    // element (30d) is not the median. The true median is 2d, which clamps to
    // the 3-day floor. A regression here (issue #22444) reads 30d and fails to
    // flag a contact that has been silent for 7 days.
    const runtime = runtimeWithContacts([
      contact({
        entityId: "10000000-0000-0000-0000-000000000003" as UUID,
        customFields: { displayName: "Robin" },
        lastInteractionAt: "2026-06-03T12:00:00.000Z",
        interactions: [
          { occurredAt: "2026-05-01T12:00:00.000Z" },
          { occurredAt: "2026-05-02T12:00:00.000Z" },
          { occurredAt: "2026-06-01T12:00:00.000Z" },
          { occurredAt: "2026-06-03T12:00:00.000Z" },
        ],
      }),
    ]);

    const now = Date.parse("2026-06-10T12:00:00.000Z");
    const digest = await computeOverdueFollowups(runtime, now, 30);

    expect(digest.overdue).toHaveLength(1);
    expect(digest.overdue[0]).toMatchObject({
      displayName: "Robin",
      thresholdDays: 3,
      daysOverdue: 4,
    });
  });

  it("holds the median at the low floor when one outlier gap sits in the temporal middle", async () => {
    // Chronological gaps [2d, 2d, 40d, 2d, 2d]: the temporal-middle element is
    // the 40d outlier, but the sorted median is 2d (clamped to the 3-day floor).
    // The buggy positional-middle read would set a 40d threshold and leave a
    // 10-day-silent contact unflagged.
    const runtime = runtimeWithContacts([
      contact({
        entityId: "10000000-0000-0000-0000-000000000004" as UUID,
        customFields: { displayName: "Sasha" },
        lastInteractionAt: "2026-05-19T12:00:00.000Z",
        interactions: [
          { occurredAt: "2026-04-01T12:00:00.000Z" },
          { occurredAt: "2026-04-03T12:00:00.000Z" },
          { occurredAt: "2026-04-05T12:00:00.000Z" },
          { occurredAt: "2026-05-15T12:00:00.000Z" },
          { occurredAt: "2026-05-17T12:00:00.000Z" },
          { occurredAt: "2026-05-19T12:00:00.000Z" },
        ],
      }),
    ]);

    const now = Date.parse("2026-05-29T12:00:00.000Z");
    const digest = await computeOverdueFollowups(runtime, now, 30);

    expect(digest.overdue).toHaveLength(1);
    expect(digest.overdue[0]).toMatchObject({
      displayName: "Sasha",
      thresholdDays: 3,
      daysOverdue: 7,
    });
  });
});
