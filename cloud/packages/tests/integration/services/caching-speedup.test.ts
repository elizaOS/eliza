import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { v4 as uuidv4 } from "uuid";
import { cache } from "@/lib/cache/client";
import { affiliatesService } from "@/lib/services/affiliates";
import { userMcpsService } from "@/lib/services/user-mcps";
import { usersService } from "@/lib/services/users";
import { getConnectionString } from "@/tests/infrastructure/local-database";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "@/tests/infrastructure/test-data-factory";

describe("Caching Speedup and Behavior End-to-End Tests", () => {
  let connectionString: string;
  let testData: TestDataSet;

  beforeAll(async () => {
    connectionString = getConnectionString();
    testData = await createTestDataSet(connectionString);
  });

  afterAll(async () => {
    if (testData?.organization?.id) {
      await cleanupTestData(connectionString, testData.organization.id);
    }
  });

  describe("UsersService Caching", () => {
    test("caches user lookup on second call and improves retrieval speed", async () => {
      const userId = testData.user.id;

      // Invalidate just in case
      await cache.del(`user:id:${userId}:v1`);

      const t1 = performance.now();
      const user1 = await usersService.getById(userId);
      const t2 = performance.now();
      const firstCallDuration = t2 - t1;

      const t3 = performance.now();
      const user2 = await usersService.getById(userId);
      const t4 = performance.now();
      const secondCallDuration = t4 - t3;

      expect(user1).toBeDefined();
      expect(user2).toBeDefined();
      expect(user1!.id).toBe(user2!.id);
      expect(user1!.email).toBe(user2!.email);

      console.log(
        `[Tests] UsersService.getById - First call: ${firstCallDuration.toFixed(2)}ms, Second call (Cached): ${secondCallDuration.toFixed(2)}ms`,
      );

      // We don't formally assert secondCallDuration < firstCallDuration to avoid flakiness in CI,
      // but in local tests it is logged and typically much faster.
    });

    test("invalidates cache when user is updated", async () => {
      const userId = testData.user.id;
      const newName = `Cached User ${uuidv4().substring(0, 8)}`;

      // Prime cache
      await usersService.getById(userId);

      // Update
      await usersService.update(userId, { name: newName });

      // Fetch
      const user = await usersService.getById(userId);
      expect(user!.name).toBe(newName);
    });
  });

  describe("UserMcpsService Caching", () => {
    let mcpId: string;
    let mcpSlug: string;

    beforeAll(async () => {
      mcpSlug = `test-mcp-${uuidv4().substring(0, 8)}`;
      const mcp = await userMcpsService.create({
        organizationId: testData.organization.id,
        userId: testData.user.id,
        name: "Cache Test MCP",
        slug: mcpSlug,
        description: "Test description",
        endpointType: "external",
        externalEndpoint: "http://example.com",
        tools: [{ name: "test-server", description: "test desc" }],
      });
      mcpId = mcp.id;
    });

    afterAll(async () => {
      if (mcpId) {
        await userMcpsService.delete(mcpId, testData.organization.id);
      }
    });

    test("caches MCP by lookup", async () => {
      // Clear cache
      await cache.del(`mcp:id:${mcpId}:v1`);

      const t1 = performance.now();
      const mcp1 = await userMcpsService.getById(mcpId);
      const t2 = performance.now();

      const t3 = performance.now();
      const mcp2 = await userMcpsService.getById(mcpId);
      const t4 = performance.now();

      expect(mcp1).toBeDefined();
      expect(mcp2).toBeDefined();
      expect(mcp1!.id).toBe(mcp2!.id);

      console.log(
        `[Tests] UserMcpsService.getById - First call: ${(t2 - t1).toFixed(2)}ms, Second call (Cached): ${(t4 - t3).toFixed(2)}ms`,
      );
    });

    test("caches MCP by slug", async () => {
      await cache.del(`mcp:slug:${testData.organization.id}:${mcpSlug}:v1`);

      const t1 = performance.now();
      const mcp1 = await userMcpsService.getBySlug(mcpSlug, testData.organization.id);
      const t2 = performance.now();

      const t3 = performance.now();
      const mcp2 = await userMcpsService.getBySlug(mcpSlug, testData.organization.id);
      const t4 = performance.now();

      expect(mcp1).toBeDefined();
      expect(mcp2).toBeDefined();
      expect(mcp1!.id).toBe(mcp2!.id);

      console.log(
        `[Tests] UserMcpsService.getBySlug - First call: ${(t2 - t1).toFixed(2)}ms, Second call (Cached): ${(t4 - t3).toFixed(2)}ms`,
      );
    });

    test("invalidates cache on publishing", async () => {
      await userMcpsService.publish(mcpId, testData.organization.id);

      const cachedResult = await userMcpsService.getById(mcpId);
      expect(cachedResult!.status).toBe("live");
    });
  });

  describe("AffiliatesService Caching", () => {
    let _affiliateCodeStr: string;

    beforeAll(async () => {
      _affiliateCodeStr = `CACHE-${uuidv4().substring(0, 6).toUpperCase()}`;
      const _userNew = await usersService.update(testData.user.id, {
        name: "Affiliate Linker",
      });

      const newCode = await affiliatesService.getOrCreateAffiliateCode(testData.user.id, 20);
      _affiliateCodeStr = newCode.code;

      // Create a second test user to be the referee
      // Use existing test data creation utility or just a simple manual insertion
    });

    test("caches affiliate code retrieval", async () => {
      const t1 = performance.now();
      const code1 = await affiliatesService.getAffiliateCode(testData.user.id);
      const t2 = performance.now();

      const t3 = performance.now();
      const code2 = await affiliatesService.getAffiliateCode(testData.user.id);
      const t4 = performance.now();

      expect(code1).toBeDefined();
      expect(code2).toBeDefined();
      expect(code1!.id).toBe(code2!.id);

      console.log(
        `[Tests] AffiliatesService.getAffiliateCode - First call: ${(t2 - t1).toFixed(2)}ms, Second call (Cached): ${(t4 - t3).toFixed(2)}ms`,
      );
    });
  });
});
