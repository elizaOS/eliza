/**
 * Organizations Service Tests
 *
 * Sociable unit tests for the Organizations Service.
 * Tests use real PostgreSQL database (no mocks).
 *
 * Key test scenarios:
 * - getById: returns org, returns undefined for non-existent
 * - getBySlug: finds by slug
 * - create: creates new organization
 * - update: updates org data
 * - updateCreditBalance: atomic credit updates
 * - delete: removes organization
 *
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { v4 as uuidv4 } from "uuid";
import { organizationsService } from "@/lib/services/organizations";
import { getConnectionString } from "@/tests/infrastructure/local-database";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "@/tests/infrastructure/test-data-factory";

describe("OrganizationsService", () => {
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
    test("returns organization when found", async () => {
      // Arrange
      const orgId = testData.organization.id;

      // Act
      const org = await organizationsService.getById(orgId);

      // Assert
      expect(org).toBeDefined();
      expect(org!.id).toBe(orgId);
      expect(org!.name).toBe(testData.organization.name);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns undefined for non-existent organization", async () => {
      // Arrange
      const fakeOrgId = uuidv4();

      // Act
      const org = await organizationsService.getById(fakeOrgId);

      // Assert
      expect(org).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("caches organization data on second call", async () => {
      // Arrange
      const orgId = testData.organization.id;

      // Act - First call should fetch from DB and cache
      const org1 = await organizationsService.getById(orgId);
      // Second call should use cache
      const org2 = await organizationsService.getById(orgId);

      // Assert - Both should return same data
      expect(org1).toBeDefined();
      expect(org2).toBeDefined();
      expect(org1!.id).toBe(org2!.id);
      expect(org1!.name).toBe(org2!.name);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // getBySlug Tests
  // ===========================================================================

  describe("getBySlug", () => {
    test("returns organization when slug matches", async () => {
      // Arrange
      const slug = testData.organization.slug;

      // Act
      const org = await organizationsService.getBySlug(slug);

      // Assert
      expect(org).toBeDefined();
      expect(org!.slug).toBe(slug);
      expect(org!.id).toBe(testData.organization.id);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns undefined for non-existent slug", async () => {
      // Arrange
      const fakeSlug = `fake-slug-${uuidv4()}`;

      // Act
      const org = await organizationsService.getBySlug(fakeSlug);

      // Assert
      expect(org).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // getWithUsers Tests
  // ===========================================================================

  describe("getWithUsers", () => {
    test("returns organization with associated users", async () => {
      // Arrange
      const orgId = testData.organization.id;

      // Act
      const result = await organizationsService.getWithUsers(orgId);

      // Assert
      expect(result).toBeDefined();
      expect(result!.id).toBe(orgId);
      // The user created in testData should be associated
      expect(result!.users).toBeDefined();
      expect(result!.users.length).toBeGreaterThanOrEqual(1);
      expect(result!.users.map((u) => (u as { id: string }).id)).toContain(testData.user.id);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // create Tests
  // ===========================================================================

  describe("create", () => {
    test("creates new organization with required fields", async () => {
      // Arrange
      const newOrgData = {
        name: `Test Create Org ${uuidv4().substring(0, 8)}`,
        slug: `test-create-${uuidv4().substring(0, 8)}`,
      };

      // Act
      const createdOrg = await organizationsService.create(newOrgData);

      // Assert
      expect(createdOrg).toBeDefined();
      expect(createdOrg.id).toBeDefined();
      expect(createdOrg.name).toBe(newOrgData.name);
      expect(createdOrg.slug).toBe(newOrgData.slug);
      expect(createdOrg.is_active).toBe(true);
      expect(Number(createdOrg.credit_balance)).toBe(100); // Default balance from DB schema

      // Cleanup
      await organizationsService.delete(createdOrg.id);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("creates organization with initial credit balance", async () => {
      // Arrange
      const newOrgData = {
        name: `Test Credit Org ${uuidv4().substring(0, 8)}`,
        slug: `test-credit-${uuidv4().substring(0, 8)}`,
        credit_balance: "500",
      };

      // Act
      const createdOrg = await organizationsService.create(newOrgData);

      // Assert
      expect(createdOrg).toBeDefined();
      expect(Number(createdOrg.credit_balance)).toBe(500);

      // Cleanup
      await organizationsService.delete(createdOrg.id);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // update Tests
  // ===========================================================================

  describe("update", () => {
    test("updates organization name", async () => {
      // Arrange
      const orgId = testData.organization.id;
      const newName = `Updated Name ${uuidv4().substring(0, 8)}`;

      // Act
      const updatedOrg = await organizationsService.update(orgId, {
        name: newName,
      });

      // Assert
      expect(updatedOrg).toBeDefined();
      expect(updatedOrg!.name).toBe(newName);

      // Verify in DB
      const fetched = await organizationsService.getById(orgId);
      expect(fetched!.name).toBe(newName);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("updates multiple fields at once", async () => {
      // Arrange
      const orgId = testData.organization.id;
      const updates = {
        name: `Multi Update ${uuidv4().substring(0, 8)}`,
        billing_email: "billing@test.local",
      };

      // Act
      const updatedOrg = await organizationsService.update(orgId, updates);

      // Assert
      expect(updatedOrg).toBeDefined();
      expect(updatedOrg!.name).toBe(updates.name);
      expect(updatedOrg!.billing_email).toBe(updates.billing_email);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns undefined when updating non-existent organization", async () => {
      // Arrange
      const fakeOrgId = uuidv4();

      // Act
      const result = await organizationsService.update(fakeOrgId, {
        name: "Should not exist",
      });

      // Assert
      expect(result).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("invalidates cache after update", async () => {
      // Arrange
      const orgId = testData.organization.id;

      // Prime the cache
      await organizationsService.getById(orgId);

      // Update the org
      const newName = `Cache Test ${uuidv4().substring(0, 8)}`;
      await organizationsService.update(orgId, { name: newName });

      // Act - Fetch again (should get updated data, not cached)
      const fetched = await organizationsService.getById(orgId);

      // Assert
      expect(fetched!.name).toBe(newName);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // updateCreditBalance Tests
  // ===========================================================================

  describe("updateCreditBalance", () => {
    test("adds credits to organization balance", async () => {
      // Arrange
      const orgId = testData.organization.id;
      const initialBalance = 100; // From testData setup
      const amountToAdd = 50;

      // Act
      const result = await organizationsService.updateCreditBalance(orgId, amountToAdd);

      // Assert
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(initialBalance + amountToAdd);

      // Verify in DB
      const org = await organizationsService.getById(orgId);
      expect(Number(org!.credit_balance)).toBe(initialBalance + amountToAdd);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("deducts credits from organization balance", async () => {
      // Arrange
      const orgId = testData.organization.id;
      const initialBalance = 100;
      const amountToDeduct = -30;

      // Act
      const result = await organizationsService.updateCreditBalance(orgId, amountToDeduct);

      // Assert
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(initialBalance + amountToDeduct);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("handles large credit additions", async () => {
      // Arrange
      const orgId = testData.organization.id;
      const largeAmount = 500000;

      // Act
      const result = await organizationsService.updateCreditBalance(orgId, largeAmount);

      // Assert
      expect(result.success).toBe(true);
      expect(result.newBalance).toBeGreaterThan(largeAmount);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // delete Tests
  // ===========================================================================

  describe("delete", () => {
    test("deletes organization", async () => {
      // Arrange - Create a new org to delete
      const orgToDelete = await organizationsService.create({
        name: `Delete Test ${uuidv4().substring(0, 8)}`,
        slug: `delete-test-${uuidv4().substring(0, 8)}`,
      });

      // Act
      await organizationsService.delete(orgToDelete.id);

      // Assert - Should no longer exist
      const fetched = await organizationsService.getById(orgToDelete.id);
      expect(fetched).toBeUndefined();

      // Cleanup original test data
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("invalidates cache after delete", async () => {
      // Arrange - Create and cache an org
      const orgToDelete = await organizationsService.create({
        name: `Cache Delete ${uuidv4().substring(0, 8)}`,
        slug: `cache-delete-${uuidv4().substring(0, 8)}`,
      });
      await organizationsService.getById(orgToDelete.id); // Prime cache

      // Act
      await organizationsService.delete(orgToDelete.id);

      // Assert - Cache should be invalidated, should return undefined
      const fetched = await organizationsService.getById(orgToDelete.id);
      expect(fetched).toBeUndefined();

      // Cleanup original test data
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // Cache Invalidation Tests
  // ===========================================================================

  describe("invalidateCache", () => {
    test("clears cached organization data", async () => {
      // Arrange
      const orgId = testData.organization.id;

      // Prime the cache
      const org1 = await organizationsService.getById(orgId);
      expect(org1).toBeDefined();

      // Act - Invalidate cache
      await organizationsService.invalidateCache(orgId);

      // Fetch again - should hit DB (we can't easily verify this without mocks,
      // but the data should still be correct)
      const org2 = await organizationsService.getById(orgId);

      // Assert - Data should still be correct
      expect(org2).toBeDefined();
      expect(org2!.id).toBe(orgId);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });
});
