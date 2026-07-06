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
});
