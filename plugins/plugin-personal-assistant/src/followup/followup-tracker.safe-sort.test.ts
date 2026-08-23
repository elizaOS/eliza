/**
 * Unit tests for safe sorting in computeOverdueFollowups.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { type ContactInfo, computeOverdueFollowups } from "./followup-tracker";

describe("computeOverdueFollowups safe sort", () => {
  it("sorts overdue contacts by daysOverdue descending with displayName tiebreak", async () => {
    const now = Date.now();
    const mockContacts: ContactInfo[] = [
      {
        entityId: "e1",
        customFields: {
          displayName: "Charlie",
          lastContactedAt: new Date(now - 40 * 86400000).toISOString(),
          followupThresholdDays: 30, // 10 days overdue
        },
      } as unknown as ContactInfo,
      {
        entityId: "e2",
        customFields: {
          displayName: "Bob",
          lastContactedAt: new Date(now - 50 * 86400000).toISOString(),
          followupThresholdDays: 30, // 20 days overdue
        },
      } as unknown as ContactInfo,
      {
        entityId: "e3",
        customFields: {
          displayName: "Alice",
          lastContactedAt: new Date(now - 50 * 86400000).toISOString(),
          followupThresholdDays: 30, // 20 days overdue (same daysOverdue as Bob -> Alice comes first)
        },
      } as unknown as ContactInfo,
    ];

    const mockRuntime = {
      getService: (name: string) =>
        name === "relationships"
          ? {
              searchContacts: async () => mockContacts,
              getContact: async () => null,
              updateContact: async () => null,
            }
          : null,
      getEntityById: async () => null,
    } as unknown as IAgentRuntime;

    const digest = await computeOverdueFollowups(mockRuntime, now, 30);
    expect(digest.overdue.length).toBe(3);
    // 20 days overdue first, tiebreak Alice before Bob, then 10 days overdue (Charlie)
    expect(digest.overdue[0].displayName).toBe("Alice");
    expect(digest.overdue[1].displayName).toBe("Bob");
    expect(digest.overdue[2].displayName).toBe("Charlie");
  });
});
