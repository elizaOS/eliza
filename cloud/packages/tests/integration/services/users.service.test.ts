/**
 * Users Service Tests
 *
 * Sociable unit tests for the Users Service.
 * Tests use real PostgreSQL database.
 *
 * Key test scenarios:
 * - getById: returns user, returns undefined for non-existent
 * - getByEmail: finds by email
 * - getByStewardId: finds by Steward ID
 * - getWithOrganization: returns user with org data
 * - listByOrganization: lists all users in org
 * - create: creates new user
 * - update: updates user data
 * - delete: removes user (with cascading org delete for last user)
 *
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { v4 as uuidv4 } from "uuid";
import { organizationsService } from "@/lib/services/organizations";
import { usersService } from "@/lib/services/users";
import { getConnectionString } from "@/tests/helpers/local-database";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "@/tests/helpers/test-data-factory";

describe("UsersService", () => {
  let connectionString: string;
  let testData: TestDataSet;

  beforeAll(async () => {
    connectionString = getConnectionString();
  });

  beforeEach(async () => {
    // Create fresh test data for each test
    testData = await createTestDataSet(connectionString, {
      creditBalance: 100,
    });
  });

  afterAll(async () => {
    // Cleanup is handled per-test, but ensure final cleanup
    if (testData?.organization?.id) {
      await cleanupTestData(connectionString, testData.organization.id);
    }
  });

  // ===========================================================================
  // getById Tests
  // ===========================================================================

  describe("getById", () => {
    test("returns user when found", async () => {
      // Arrange
      const userId = testData.user.id;

      // Act
      const user = await usersService.getById(userId);

      // Assert
      expect(user).toBeDefined();
      expect(user!.id).toBe(userId);
      expect(user!.email).toBe(testData.user.email);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns undefined for non-existent user", async () => {
      // Arrange
      const fakeUserId = uuidv4();

      // Act
      const user = await usersService.getById(fakeUserId);

      // Assert
      expect(user).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // getByEmail Tests
  // ===========================================================================

  describe("getByEmail", () => {
    test("returns user when email matches", async () => {
      // Arrange
      const email = testData.user.email;

      // Act
      const user = await usersService.getByEmail(email);

      // Assert
      expect(user).toBeDefined();
      expect(user!.email).toBe(email);
      expect(user!.id).toBe(testData.user.id);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns undefined for non-existent email", async () => {
      // Arrange
      const fakeEmail = `nonexistent-${uuidv4()}@test.local`;

      // Act
      const user = await usersService.getByEmail(fakeEmail);

      // Assert
      expect(user).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("handles case sensitivity based on database collation", async () => {
      // Arrange
      const email = testData.user.email;
      if (email === null || email === undefined) {
        throw new Error("fixture user must have an email");
      }
      const uppercaseEmail = email.toUpperCase();

      // Act
      const user = await usersService.getByEmail(uppercaseEmail);

      // Assert - Behavior depends on DB collation
      // PostgreSQL default is case-sensitive, so uppercase lookup may return undefined
      if (user) {
        // If found, emails should match (case-insensitive comparison)
        expect((user.email ?? "").toLowerCase()).toBe(email.toLowerCase());
      } else {
        // Case-sensitive DB - original email should still work
        const originalUser = await usersService.getByEmail(email);
        expect(originalUser).toBeDefined();
        expect(originalUser!.email).toBe(email);
      }

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // getByStewardId Tests
  // ===========================================================================

  describe("getByStewardId", () => {
    test("returns user with organization when identity row matches", async () => {
      // Arrange
      const stewardId = `steward_${uuidv4()}`;

      await usersService.update(testData.user.id, { steward_user_id: stewardId });
      await usersService.upsertStewardIdentity(testData.user.id, stewardId);

      // Act
      const user = await usersService.getByStewardId(stewardId);

      // Assert
      expect(user).toBeDefined();
      expect(user!.steward_user_id).toBe(stewardId);
      expect(user!.organization).toBeDefined();
      expect(user!.organization_id).toBe(testData.organization.id);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("falls back to users.steward_user_id when identity row is missing", async () => {
      // Arrange
      const stewardId = `steward_${uuidv4()}`;
      await usersService.update(testData.user.id, { steward_user_id: stewardId });

      // Act
      const user = await usersService.getByStewardId(stewardId);

      // Assert
      expect(user).toBeDefined();
      expect(user!.id).toBe(testData.user.id);
      expect(user!.steward_user_id).toBe(stewardId);
      expect(user!.organization).toBeDefined();
      expect(user!.organization_id).toBe(testData.organization.id);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns undefined for non-existent Steward ID", async () => {
      // Arrange
      const fakeStewardId = `steward_${uuidv4()}`;

      // Act
      const user = await usersService.getByStewardId(fakeStewardId);

      // Assert
      expect(user).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  describe("upsertStewardIdentity", () => {
    test("creates and updates the identity projection idempotently", async () => {
      const firstStewardId = `steward_${uuidv4()}`;
      const secondStewardId = `steward_${uuidv4()}`;

      await usersService.update(testData.user.id, {
        steward_user_id: firstStewardId,
      });
      await usersService.upsertStewardIdentity(testData.user.id, firstStewardId);

      const firstLookup = await usersService.getByStewardId(firstStewardId);
      expect(firstLookup?.id).toBe(testData.user.id);

      await usersService.update(testData.user.id, {
        steward_user_id: secondStewardId,
      });
      await usersService.upsertStewardIdentity(testData.user.id, secondStewardId);

      const secondLookup = await usersService.getByStewardId(secondStewardId);
      expect(secondLookup?.id).toBe(testData.user.id);

      const previousLookup = await usersService.getByStewardId(firstStewardId);
      expect(previousLookup).toBeUndefined();

      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("write-path lookup falls back to users.steward_user_id when projection is missing", async () => {
      const stewardId = `steward_${uuidv4()}`;

      await usersService.update(testData.user.id, {
        steward_user_id: stewardId,
      });

      const user = await usersService.getByStewardIdForWrite(stewardId);

      expect(user).toBeDefined();
      expect(user?.id).toBe(testData.user.id);
      expect(user?.organization_id).toBe(testData.organization.id);

      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("concurrent inserts for the same Steward ID leave one canonical winner", async () => {
      const stewardId = `steward_${uuidv4()}`;
      const secondData = await createTestDataSet(connectionString, {
        creditBalance: 100,
      });

      try {
        const [firstResult, secondResult] = await Promise.allSettled([
          usersService.upsertStewardIdentity(testData.user.id, stewardId),
          usersService.upsertStewardIdentity(secondData.user.id, stewardId),
        ]);

        expect(
          [firstResult.status, secondResult.status].filter((status) => status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          [firstResult.status, secondResult.status].filter((status) => status === "rejected"),
        ).toHaveLength(1);

        const user = await usersService.getByStewardId(stewardId);

        expect(user).toBeDefined();
        const winnerId = user!.id;
        expect([testData.user.id, secondData.user.id]).toContain(winnerId);
      } finally {
        await cleanupTestData(connectionString, secondData.organization.id);
        await cleanupTestData(connectionString, testData.organization.id);
      }
    }, 15_000);
  });

  // ===========================================================================
  // getWithOrganization Tests
  // ===========================================================================

  describe("getWithOrganization", () => {
    test("returns user with full organization data", async () => {
      // Arrange
      const userId = testData.user.id;

      // Act
      const user = await usersService.getWithOrganization(userId);

      // Assert
      expect(user).toBeDefined();
      expect(user!.id).toBe(userId);
      expect(user!.organization).toBeDefined();
      expect(user!.organization!.id).toBe(testData.organization.id);
      expect(user!.organization!.name).toBe(testData.organization.name);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns undefined for non-existent user", async () => {
      // Arrange
      const fakeUserId = uuidv4();

      // Act
      const user = await usersService.getWithOrganization(fakeUserId);

      // Assert
      expect(user).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // getByEmailWithOrganization Tests
  // ===========================================================================

  describe("getByEmailWithOrganization", () => {
    test("returns user with organization when email matches", async () => {
      // Arrange
      const email = testData.user.email;

      // Act
      const user = await usersService.getByEmailWithOrganization(email);

      // Assert
      expect(user).toBeDefined();
      expect(user!.email).toBe(email);
      expect(user!.organization).toBeDefined();
      expect(user!.organization!.id).toBe(testData.organization.id);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // getByWalletAddress Tests
  // ===========================================================================

  describe("getByWalletAddress", () => {
    test("returns user when wallet address matches", async () => {
      // Arrange - Set a wallet address on user
      const walletAddress = `0x${uuidv4().replace(/-/g, "").substring(0, 40)}`;
      await usersService.update(testData.user.id, {
        wallet_address: walletAddress,
      });

      // Act
      const user = await usersService.getByWalletAddress(walletAddress);

      // Assert
      expect(user).toBeDefined();
      expect(user!.wallet_address).toBe(walletAddress);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns undefined for non-existent wallet", async () => {
      // Arrange
      const fakeWallet = `0x${uuidv4().replace(/-/g, "").substring(0, 40)}`;

      // Act
      const user = await usersService.getByWalletAddress(fakeWallet);

      // Assert
      expect(user).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // listByOrganization Tests
  // ===========================================================================

  describe("listByOrganization", () => {
    test("returns all users in organization", async () => {
      // Arrange
      const orgId = testData.organization.id;

      // Act
      const users = await usersService.listByOrganization(orgId);

      // Assert
      expect(users).toBeDefined();
      expect(users.length).toBeGreaterThanOrEqual(1);
      expect(users.some((u) => u.id === testData.user.id)).toBe(true);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns empty array for organization with no users", async () => {
      // Arrange - Create an org without users
      const emptyOrg = await organizationsService.create({
        name: `Empty Org ${uuidv4().substring(0, 8)}`,
        slug: `empty-org-${uuidv4().substring(0, 8)}`,
      });

      // Act
      const users = await usersService.listByOrganization(emptyOrg.id);

      // Assert
      expect(users).toEqual([]);

      // Cleanup
      await organizationsService.delete(emptyOrg.id);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // create Tests
  // ===========================================================================

  describe("create", () => {
    test("creates new user with required fields", async () => {
      // Arrange
      const newUserData = {
        email: `create-test-${uuidv4()}@test.local`,
        organization_id: testData.organization.id,
        role: "member" as const,
      };

      // Act
      const createdUser = await usersService.create(newUserData);

      // Assert
      expect(createdUser).toBeDefined();
      expect(createdUser.id).toBeDefined();
      expect(createdUser.email).toBe(newUserData.email);
      expect(createdUser.organization_id).toBe(testData.organization.id);
      expect(createdUser.role).toBe("member");
      expect(createdUser.is_active).toBe(true);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("creates user with optional fields", async () => {
      // Arrange
      const walletAddress = `0x${uuidv4().replace(/-/g, "").substring(0, 40)}`;
      const newUserData = {
        email: `optional-test-${uuidv4()}@test.local`,
        organization_id: testData.organization.id,
        role: "admin" as const,
        wallet_address: walletAddress,
        name: "Test User Name",
      };

      // Act
      const createdUser = await usersService.create(newUserData);

      // Assert
      expect(createdUser.role).toBe("admin");
      expect(createdUser.wallet_address).toBe(walletAddress);
      expect(createdUser.name).toBe("Test User Name");

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // update Tests
  // ===========================================================================

  describe("update", () => {
    test("updates user email", async () => {
      // Arrange
      const userId = testData.user.id;
      const newEmail = `updated-${uuidv4()}@test.local`;

      // Act
      const updatedUser = await usersService.update(userId, {
        email: newEmail,
      });

      // Assert
      expect(updatedUser).toBeDefined();
      expect(updatedUser!.email).toBe(newEmail);

      // Verify in DB
      const fetched = await usersService.getById(userId);
      expect(fetched!.email).toBe(newEmail);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("updates user role", async () => {
      // Arrange
      const userId = testData.user.id;

      // Act
      const updatedUser = await usersService.update(userId, { role: "admin" });

      // Assert
      expect(updatedUser!.role).toBe("admin");

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("updates multiple fields at once", async () => {
      // Arrange
      const userId = testData.user.id;
      const updates = {
        name: "Updated Name",
        role: "admin" as const,
      };

      // Act
      const updatedUser = await usersService.update(userId, updates);

      // Assert
      expect(updatedUser!.name).toBe("Updated Name");
      expect(updatedUser!.role).toBe("admin");

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns undefined when updating non-existent user", async () => {
      // Arrange
      const fakeUserId = uuidv4();

      // Act
      const result = await usersService.update(fakeUserId, { name: "Test" });

      // Assert
      expect(result).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // delete Tests
  // ===========================================================================

  describe("delete", () => {
    test("deletes user from organization", async () => {
      // Arrange - Create a second user so org doesn't get deleted
      const _secondUser = await usersService.create({
        email: `second-${uuidv4()}@test.local`,
        organization_id: testData.organization.id,
        role: "member",
      });

      const userToDelete = await usersService.create({
        email: `delete-${uuidv4()}@test.local`,
        organization_id: testData.organization.id,
        role: "member",
      });

      // Act
      await usersService.delete(userToDelete.id);

      // Assert - User should no longer exist
      const fetched = await usersService.getById(userToDelete.id);
      expect(fetched).toBeUndefined();

      // Org should still exist
      const org = await organizationsService.getById(testData.organization.id);
      expect(org).toBeDefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("throws error when deleting non-existent user", async () => {
      // Arrange
      const fakeUserId = uuidv4();

      // Act & Assert
      await expect(usersService.delete(fakeUserId)).rejects.toThrow(`User ${fakeUserId} not found`);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("deletes organization when last user is deleted", async () => {
      // Arrange - Create a new org with one user
      const newOrg = await organizationsService.create({
        name: `Cascade Org ${uuidv4().substring(0, 8)}`,
        slug: `cascade-org-${uuidv4().substring(0, 8)}`,
      });

      const onlyUser = await usersService.create({
        email: `only-user-${uuidv4()}@test.local`,
        organization_id: newOrg.id,
        role: "owner",
      });

      // Act - Delete the only user
      await usersService.delete(onlyUser.id);

      // Assert - Organization should also be deleted
      const org = await organizationsService.getById(newOrg.id);
      expect(org).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // Integration Tests
  // ===========================================================================

  describe("Integration", () => {
    test("full user lifecycle: create, update, delete", async () => {
      // Create
      const user = await usersService.create({
        email: `lifecycle-${uuidv4()}@test.local`,
        organization_id: testData.organization.id,
        role: "member",
      });
      expect(user.id).toBeDefined();

      // Verify creation
      const fetched = await usersService.getById(user.id);
      expect(fetched).toBeDefined();
      expect(fetched!.email).toBe(user.email);

      // Update
      const updated = await usersService.update(user.id, {
        name: "Lifecycle User",
        role: "admin",
      });
      expect(updated!.name).toBe("Lifecycle User");
      expect(updated!.role).toBe("admin");

      // Delete
      await usersService.delete(user.id);

      // Verify deletion
      const deleted = await usersService.getById(user.id);
      expect(deleted).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });
});
