/**
 * Integration Tests: Case-Insensitive Username Lookup
 *
 * Tests the case-insensitive username lookup functionality:
 * - findUserByIdentifier with different case variations
 * - findUserByIdentifierWithSelect with different case variations
 * - API route case-insensitive lookups
 *
 * Issue: BAB-100 - Agent profile loading with usernames containing spaces/mixed case
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  findUserByIdentifier,
  findUserByIdentifierWithSelect,
} from "@feed/api";
import { db, eq, users } from "@feed/db";
import { generateSnowflakeId } from "@feed/shared";

// Test user IDs that we'll clean up
const testUserIds: string[] = [];

/**
 * Creates a test user with the given username
 */
async function createTestUser(
  username: string,
  overrides: Partial<typeof users.$inferInsert> = {},
) {
  const userId = await generateSnowflakeId();
  const now = new Date();

  await db.insert(users).values({
    id: userId,
    privyId: `steward:test:test-case-${userId}`,
    username,
    displayName: `Test User ${username}`,
    profileComplete: true,
    reputationPoints: 1000,
    invitePoints: 0,
    earnedPoints: 0,
    bonusPoints: 0,
    referralCount: 0,
    updatedAt: now,
    ...overrides,
  });

  testUserIds.push(userId);
  return { userId, username };
}

/**
 * Cleanup test data after all tests
 */
async function cleanupTestData() {
  for (const userId of testUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
  testUserIds.length = 0;
}

describe("Case-Insensitive Username Lookup", () => {
  let testUserId: string;
  const testUsername = "TestCaseUser";

  beforeAll(async () => {
    // Create a test user with mixed case username
    const { userId } = await createTestUser(testUsername);
    testUserId = userId;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe("findUserByIdentifier", () => {
    it("should find user with exact case match", async () => {
      const user = await findUserByIdentifier(testUsername);
      expect(user).not.toBeNull();
      expect(user?.id).toBe(testUserId);
      expect(user?.username).toBe(testUsername);
    });

    it("should find user with lowercase username", async () => {
      const user = await findUserByIdentifier(testUsername.toLowerCase());
      expect(user).not.toBeNull();
      expect(user?.id).toBe(testUserId);
      expect(user?.username).toBe(testUsername);
    });

    it("should find user with uppercase username", async () => {
      const user = await findUserByIdentifier(testUsername.toUpperCase());
      expect(user).not.toBeNull();
      expect(user?.id).toBe(testUserId);
      expect(user?.username).toBe(testUsername);
    });

    it("should find user with random case variation", async () => {
      const randomCase = "tEsTcAsEuSeR";
      const user = await findUserByIdentifier(randomCase);
      expect(user).not.toBeNull();
      expect(user?.id).toBe(testUserId);
      expect(user?.username).toBe(testUsername);
    });

    it("should still find user by ID (unchanged behavior)", async () => {
      const user = await findUserByIdentifier(testUserId);
      expect(user).not.toBeNull();
      expect(user?.id).toBe(testUserId);
    });

    it("should honor select projection when provided", async () => {
      const user = (await findUserByIdentifier(testUsername, {
        id: true,
      })) as { id: string } | null;
      expect(user).not.toBeNull();
      expect(user?.id).toBe(testUserId);
      expect(Object.keys(user ?? {})).toEqual(["id"]);
    });

    it("should return null for non-existent username", async () => {
      const user = await findUserByIdentifier("nonexistent-user-12345");
      expect(user).toBeNull();
    });
  });

  describe("findUserByIdentifierWithSelect", () => {
    it("should find user with lowercase and return selected fields", async () => {
      const user = await findUserByIdentifierWithSelect(
        testUsername.toLowerCase(),
        {
          id: users.id,
          username: users.username,
        },
      );
      expect(user).not.toBeNull();
      // Cast to access string values from the result
      const result = user as { id: string; username: string | null } | null;
      expect(result?.id).toBe(testUserId);
      expect(result?.username).toBe(testUsername);
    });

    it("should find user with uppercase and return selected fields", async () => {
      const user = await findUserByIdentifierWithSelect(
        testUsername.toUpperCase(),
        {
          id: users.id,
          username: users.username,
          displayName: users.displayName,
        },
      );
      expect(user).not.toBeNull();
      // Cast to access string values from the result
      const result = user as {
        id: string;
        username: string | null;
        displayName: string | null;
      } | null;
      expect(result?.id).toBe(testUserId);
      expect(result?.displayName).toBe(`Test User ${testUsername}`);
    });
  });

  describe("Username with spaces", () => {
    let spaceUserId: string;
    const spaceUsername = "Bill Ackman";

    beforeAll(async () => {
      const { userId } = await createTestUser(spaceUsername);
      spaceUserId = userId;
    });

    it("should find user with exact username including spaces", async () => {
      const user = await findUserByIdentifier(spaceUsername);
      expect(user).not.toBeNull();
      expect(user?.id).toBe(spaceUserId);
    });

    it("should find user with lowercase version of spaced username", async () => {
      const user = await findUserByIdentifier(spaceUsername.toLowerCase());
      expect(user).not.toBeNull();
      expect(user?.id).toBe(spaceUserId);
    });

    it("should find user with uppercase version of spaced username", async () => {
      const user = await findUserByIdentifier(spaceUsername.toUpperCase());
      expect(user).not.toBeNull();
      expect(user?.id).toBe(spaceUserId);
    });
  });

  describe("Edge cases", () => {
    it("should not find user when username is similar but not case-equivalent", async () => {
      // This tests that case-insensitive matching works correctly
      // and doesn't match partial or different usernames
      const user = await findUserByIdentifier("TestCase"); // Different from TestCaseUser
      expect(user).toBeNull();
    });

    it("should handle empty string gracefully", async () => {
      const user = await findUserByIdentifier("");
      expect(user).toBeNull();
    });
  });
});
