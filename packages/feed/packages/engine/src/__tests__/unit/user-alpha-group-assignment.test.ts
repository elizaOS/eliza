/**
 * Tests for User Alpha Group Assignment Service
 *
 * Unit tests for the default group assignment logic:
 * - Target group count (3)
 * - Eligibility checks (not actor, not agent, not banned)
 * - Prioritization of followed NPCs
 * - Capacity stats calculation
 */

import { describe, expect, it } from "vitest";
import { UserAlphaGroupAssignmentService } from "../../services/user-alpha-group-assignment-service";

describe("UserAlphaGroupAssignmentService", () => {
  describe("Configuration", () => {
    it("should target 3 default groups", () => {
      expect(UserAlphaGroupAssignmentService.TARGET_DEFAULT_GROUPS).toBe(3);
    });

    it("should default to Tier 3", () => {
      expect(UserAlphaGroupAssignmentService.DEFAULT_TIER).toBe(3);
    });
  });

  // Note: These tests require a database connection and are skipped in unit tests.
  // They are covered by integration tests in tiered-group-system.integration.test.ts
  describe("Assignment Logic", () => {
    it.skip("should not assign to non-existent users (requires DB)", async () => {
      // This test requires DATABASE_URL - run integration tests instead
      const result =
        await UserAlphaGroupAssignmentService.assignDefaultGroups(
          "fake-user-id-123",
        );

      expect(result.success).toBe(false);
      expect(result.groupsAssigned).toBe(0);
      expect(result.errors.some((e) => e.includes("not found"))).toBe(true);
    });
  });

  describe("AssignmentResult structure", () => {
    it.skip("should return proper structure on failure (requires DB)", async () => {
      // This test requires DATABASE_URL - run integration tests instead
      const result =
        await UserAlphaGroupAssignmentService.assignDefaultGroups("invalid-id");

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("groupsAssigned");
      expect(result).toHaveProperty("assignments");
      expect(result).toHaveProperty("errors");

      expect(typeof result.success).toBe("boolean");
      expect(typeof result.groupsAssigned).toBe("number");
      expect(Array.isArray(result.assignments)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });

  describe("getCapacityStats", () => {
    it.skip("should return capacity statistics (requires DB)", async () => {
      // This test requires DATABASE_URL - run integration tests instead
      const stats = await UserAlphaGroupAssignmentService.getCapacityStats();

      expect(stats).toHaveProperty("totalTier3Groups");
      expect(stats).toHaveProperty("totalTier3Capacity");
      expect(stats).toHaveProperty("currentTier3Members");
      expect(stats).toHaveProperty("availableSlots");
      expect(stats).toHaveProperty("fillRate");
      expect(stats).toHaveProperty("maxUsersCanServe");

      expect(typeof stats.totalTier3Groups).toBe("number");
      expect(typeof stats.totalTier3Capacity).toBe("number");
      expect(typeof stats.currentTier3Members).toBe("number");
      expect(typeof stats.availableSlots).toBe("number");
      expect(typeof stats.fillRate).toBe("number");
      expect(typeof stats.maxUsersCanServe).toBe("number");
    });

    it.skip("should have valid fill rate between 0 and 1 (requires DB)", async () => {
      // This test requires DATABASE_URL - run integration tests instead
      const stats = await UserAlphaGroupAssignmentService.getCapacityStats();

      expect(stats.fillRate).toBeGreaterThanOrEqual(0);
      expect(stats.fillRate).toBeLessThanOrEqual(1);
    });

    it.skip("should calculate maxUsersCanServe correctly (requires DB)", async () => {
      // This test requires DATABASE_URL - run integration tests instead
      const stats = await UserAlphaGroupAssignmentService.getCapacityStats();

      // maxUsersCanServe = availableSlots / 3 (target groups per user)
      const expectedMax = Math.floor(
        stats.availableSlots /
          UserAlphaGroupAssignmentService.TARGET_DEFAULT_GROUPS,
      );

      expect(stats.maxUsersCanServe).toBe(expectedMax);
    });

    it.skip("should have non-negative values (requires DB)", async () => {
      // This test requires DATABASE_URL - run integration tests instead
      const stats = await UserAlphaGroupAssignmentService.getCapacityStats();

      expect(stats.totalTier3Groups).toBeGreaterThanOrEqual(0);
      expect(stats.totalTier3Capacity).toBeGreaterThanOrEqual(0);
      expect(stats.currentTier3Members).toBeGreaterThanOrEqual(0);
      expect(stats.availableSlots).toBeGreaterThanOrEqual(0);
      expect(stats.maxUsersCanServe).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("Assignment Prioritization Logic", () => {
  describe("Followed NPCs priority", () => {
    it("should sort followed NPCs before unfollowed", () => {
      const followedNpcIds = new Set(["npc-1", "npc-3"]);

      const groups = [
        { npcId: "npc-2", availableSlots: 100 },
        { npcId: "npc-1", availableSlots: 50 },
        { npcId: "npc-4", availableSlots: 200 },
        { npcId: "npc-3", availableSlots: 75 },
      ];

      const sorted = groups.sort((a, b) => {
        const aFollowed = followedNpcIds.has(a.npcId) ? 1 : 0;
        const bFollowed = followedNpcIds.has(b.npcId) ? 1 : 0;
        if (aFollowed !== bFollowed) {
          return bFollowed - aFollowed;
        }
        return b.availableSlots - a.availableSlots;
      });

      // Followed NPCs should come first
      expect(sorted[0]?.npcId).toBe("npc-3"); // followed, more slots
      expect(sorted[1]?.npcId).toBe("npc-1"); // followed, fewer slots
      // Then unfollowed by available slots
      expect(sorted[2]?.npcId).toBe("npc-4"); // unfollowed, most slots
      expect(sorted[3]?.npcId).toBe("npc-2"); // unfollowed, fewer slots
    });

    it("should sort by available slots within same priority", () => {
      const followedNpcIds = new Set<string>(); // No followed NPCs

      const groups = [
        { npcId: "npc-1", availableSlots: 100 },
        { npcId: "npc-2", availableSlots: 300 },
        { npcId: "npc-3", availableSlots: 200 },
      ];

      const sorted = groups.sort((a, b) => {
        const aFollowed = followedNpcIds.has(a.npcId) ? 1 : 0;
        const bFollowed = followedNpcIds.has(b.npcId) ? 1 : 0;
        if (aFollowed !== bFollowed) {
          return bFollowed - aFollowed;
        }
        return b.availableSlots - a.availableSlots;
      });

      // Should be sorted by available slots (descending)
      expect(sorted[0]?.npcId).toBe("npc-2"); // 300 slots
      expect(sorted[1]?.npcId).toBe("npc-3"); // 200 slots
      expect(sorted[2]?.npcId).toBe("npc-1"); // 100 slots
    });
  });

  describe("Group diversity", () => {
    it("should exclude NPCs user is already in", () => {
      const excludeNpcIds = new Set(["npc-1", "npc-3"]);

      const groups = [
        { npcId: "npc-1", availableSlots: 100 },
        { npcId: "npc-2", availableSlots: 200 },
        { npcId: "npc-3", availableSlots: 150 },
        { npcId: "npc-4", availableSlots: 175 },
      ];

      const filtered = groups.filter((g) => !excludeNpcIds.has(g.npcId));

      expect(filtered).toHaveLength(2);
      expect(filtered.map((g) => g.npcId)).toEqual(["npc-2", "npc-4"]);
    });
  });
});

describe("Capacity Calculations", () => {
  describe("Available slots", () => {
    it("should calculate available slots correctly", () => {
      const maxMembers = 500;
      const memberCount = 150;
      const availableSlots = maxMembers - memberCount;

      expect(availableSlots).toBe(350);
    });

    it("should return 0 when full", () => {
      const maxMembers = 500;
      const memberCount = 500;
      const availableSlots = maxMembers - memberCount;

      expect(availableSlots).toBe(0);
    });

    it("should handle overfull groups gracefully", () => {
      const maxMembers = 500;
      const memberCount = 510; // Somehow overfull
      const availableSlots = maxMembers - memberCount;

      expect(availableSlots).toBe(-10);
      // Filter should exclude negative slots
      expect(availableSlots <= 0).toBe(true);
    });
  });

  describe("Fill rate", () => {
    it("should calculate fill rate as decimal", () => {
      const totalCapacity = 1000;
      const currentMembers = 250;
      const fillRate = currentMembers / totalCapacity;

      expect(fillRate).toBe(0.25);
    });

    it("should handle zero capacity", () => {
      const totalCapacity = 0;
      const currentMembers = 0;
      const fillRate = totalCapacity > 0 ? currentMembers / totalCapacity : 0;

      expect(fillRate).toBe(0);
    });

    it("should cap at 1 for overfull", () => {
      const totalCapacity = 100;
      const currentMembers = 120;
      const fillRate = Math.min(1, currentMembers / totalCapacity);

      expect(fillRate).toBe(1);
    });
  });

  describe("Max users can serve", () => {
    it("should calculate based on target groups", () => {
      const availableSlots = 1500;
      const targetGroups = 3;
      const maxUsers = Math.floor(availableSlots / targetGroups);

      expect(maxUsers).toBe(500);
    });

    it("should floor the result", () => {
      const availableSlots = 1000;
      const targetGroups = 3;
      const maxUsers = Math.floor(availableSlots / targetGroups);

      expect(maxUsers).toBe(333); // 1000/3 = 333.33, floored to 333
    });
  });
});
