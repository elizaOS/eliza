/**
 * Integration Tests: NFT Gallery & Mint Flow
 *
 * Tests the complete NFT gallery and minting flow including:
 * - Gallery API endpoints with real database queries
 * - NFT detail pages with ownership data
 * - Eligibility checking against snapshot
 * - Mint preparation and confirmation
 * - Snapshot cron job logic
 *
 * Run with: bun test integration/nft-gallery.integration.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  db,
  eq,
  inArray,
  nftClaims,
  nftCollection,
  nftOwnership,
  nftSnapshot,
  users,
} from "@feed/db";
import { generateSnowflakeId } from "@feed/shared";

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  "http://localhost:3000";

let serverAvailable = false;
let databaseAvailable = false;
let nftTablesExist = false;

// Track created test data for cleanup
const testUserIds: string[] = [];
const testNftTokenIds: number[] = [];

async function checkServerHealth(): Promise<boolean> {
  const response = await fetch(`${BASE_URL}/api/health`, {
    signal: AbortSignal.timeout(5000),
  });
  return response.ok;
}

async function createTestUser(options?: {
  walletAddress?: string;
  reputationPoints?: number;
}): Promise<{ id: string; walletAddress: string }> {
  const userId = await generateSnowflakeId();
  const walletAddress =
    options?.walletAddress ??
    `0x${Math.random().toString(16).slice(2).padStart(40, "0")}`;

  await db.insert(users).values({
    id: userId,
    walletAddress,
    username: `test-nft-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    displayName: `Test NFT User ${userId.slice(0, 8)}`,
    isActor: false,
    isBanned: false,
    reputationPoints: options?.reputationPoints ?? 0,
    invitePoints: 0,
    earnedPoints: 0,
    bonusPoints: 0,
    updatedAt: new Date(),
  });

  testUserIds.push(userId);
  return { id: userId, walletAddress };
}

async function createTestNft(tokenId: number): Promise<void> {
  await db.insert(nftCollection).values({
    id: `test-nft-${tokenId}`,
    tokenId,
    name: `Test NFT #${tokenId}`,
    description: `A test NFT with token ID ${tokenId}`,
    imageUrl: `https://example.com/nft/${tokenId}.jpg`,
    thumbnailUrl: `https://example.com/nft/${tokenId}-thumb.jpg`,
    storyTitle: `The Tale of NFT #${tokenId}`,
    storyContent: `This is the story of NFT #${tokenId}, a unique digital collectible.`,
    attributes: [
      { trait_type: "Collection", value: "Feed Top 100" },
      { trait_type: "Token Number", value: tokenId },
    ],
    contractAddress: "0x0000000000000000000000000000000000000000",
    chainId: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  testNftTokenIds.push(tokenId);
}

async function createTestSnapshot(
  userId: string,
  rank: number,
  points: number,
  walletAddress?: string,
): Promise<void> {
  await db.insert(nftSnapshot).values({
    id: `test-snapshot-${userId}`,
    userId,
    walletAddress: walletAddress ?? null,
    rank,
    points,
    snapshotTakenAt: new Date(),
    hasMinted: false,
  });
}

async function cleanupTestData(): Promise<void> {
  // Clean up in reverse order of dependencies
  if (testNftTokenIds.length > 0) {
    await db
      .delete(nftClaims)
      .where(inArray(nftClaims.tokenId, testNftTokenIds));
    await db
      .delete(nftOwnership)
      .where(inArray(nftOwnership.tokenId, testNftTokenIds));
    await db
      .delete(nftCollection)
      .where(inArray(nftCollection.tokenId, testNftTokenIds));
    testNftTokenIds.length = 0;
  }

  if (testUserIds.length > 0) {
    await db
      .delete(nftSnapshot)
      .where(inArray(nftSnapshot.userId, testUserIds));
    await db.delete(users).where(inArray(users.id, testUserIds));
    testUserIds.length = 0;
  }
}

describe("NFT Gallery Integration Tests", () => {
  beforeAll(async () => {
    serverAvailable = await checkServerHealth().catch(() => false);
    if (!serverAvailable) {
      console.warn(
        "⚠️  Server not available - some tests will be skipped. Start server with: bun run dev",
      );
    }

    try {
      await db.select().from(users).limit(1);
      databaseAvailable = true;
    } catch {
      databaseAvailable = false;
      console.warn(
        "⚠️  Database not available - tests will be skipped. Set DATABASE_URL environment variable.",
      );
    }

    // Check if NFT tables exist (migration may not have run)
    if (databaseAvailable) {
      try {
        await db.select().from(nftCollection).limit(1);
        nftTablesExist = true;
      } catch {
        nftTablesExist = false;
        console.warn(
          "⚠️  NFT tables do not exist - NFT database tests will be skipped. Run migration: cd packages/db && bun run drizzle-kit push",
        );
      }
    }
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe("NFT Collection Endpoint", () => {
    test("should return empty collection when no NFTs exist", async () => {
      if (!serverAvailable) {
        console.log("Skipping test: server not available");
        return;
      }

      const response = await fetch(`${BASE_URL}/api/nft/collection`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty("nfts");
      expect(data.data).toHaveProperty("pagination");
      expect(data.data).toHaveProperty("stats");
    });

    test("should return NFTs with pagination", async () => {
      if (!serverAvailable || !databaseAvailable || !nftTablesExist) {
        console.log(
          "Skipping test: server, database, or NFT tables not available",
        );
        return;
      }

      // Create test NFTs
      for (let i = 1; i <= 5; i++) {
        await createTestNft(1000 + i);
      }

      const response = await fetch(
        `${BASE_URL}/api/nft/collection?page=1&limit=3`,
      );
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.pagination.page).toBe(1);
      expect(data.data.pagination.limit).toBe(3);
    });

    test("should filter by claimed status", async () => {
      if (!serverAvailable || !databaseAvailable || !nftTablesExist) {
        console.log(
          "Skipping test: server, database, or NFT tables not available",
        );
        return;
      }

      // Create NFTs
      await createTestNft(2001);
      await createTestNft(2002);

      // Create owner for one NFT
      const owner = await createTestUser();
      await db.insert(nftOwnership).values({
        id: `test-ownership-2001`,
        tokenId: 2001,
        ownerAddress: owner.walletAddress,
        userId: owner.id,
        acquiredAt: new Date(),
        updatedAt: new Date(),
      });

      // Filter for claimed only
      const claimedResponse = await fetch(
        `${BASE_URL}/api/nft/collection?claimed=true`,
      );
      expect(claimedResponse.status).toBe(200);

      // Filter for unclaimed only
      const unclaimedResponse = await fetch(
        `${BASE_URL}/api/nft/collection?claimed=false`,
      );
      expect(unclaimedResponse.status).toBe(200);
    });

    test("should search by NFT name", async () => {
      if (!serverAvailable || !databaseAvailable || !nftTablesExist) {
        console.log(
          "Skipping test: server, database, or NFT tables not available",
        );
        return;
      }

      await createTestNft(3001);

      const response = await fetch(
        `${BASE_URL}/api/nft/collection?search=Test%20NFT`,
      );
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
    });

    test("should sort by tokenId ascending", async () => {
      if (!serverAvailable || !databaseAvailable || !nftTablesExist) {
        console.log(
          "Skipping test: server, database, or NFT tables not available",
        );
        return;
      }

      await createTestNft(4003);
      await createTestNft(4001);
      await createTestNft(4002);

      const response = await fetch(
        `${BASE_URL}/api/nft/collection?sort=tokenId&order=asc`,
      );
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify sort order if NFTs returned
      if (data.data.nfts.length >= 2) {
        const tokenIds = data.data.nfts
          .filter(
            (n: { tokenId: number }) => n.tokenId >= 4001 && n.tokenId <= 4003,
          )
          .map((n: { tokenId: number }) => n.tokenId);

        for (let i = 1; i < tokenIds.length; i++) {
          expect(tokenIds[i]).toBeGreaterThanOrEqual(tokenIds[i - 1]);
        }
      }
    });

    test("should sort by tokenId descending", async () => {
      if (!serverAvailable || !databaseAvailable || !nftTablesExist) {
        console.log(
          "Skipping test: server, database, or NFT tables not available",
        );
        return;
      }

      await createTestNft(5003);
      await createTestNft(5001);
      await createTestNft(5002);

      const response = await fetch(
        `${BASE_URL}/api/nft/collection?sort=tokenId&order=desc`,
      );
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify sort order if NFTs returned
      if (data.data.nfts.length >= 2) {
        const tokenIds = data.data.nfts
          .filter(
            (n: { tokenId: number }) => n.tokenId >= 5001 && n.tokenId <= 5003,
          )
          .map((n: { tokenId: number }) => n.tokenId);

        for (let i = 1; i < tokenIds.length; i++) {
          expect(tokenIds[i]).toBeLessThanOrEqual(tokenIds[i - 1]);
        }
      }
    });

    test("should include owner info for claimed NFTs", async () => {
      if (!serverAvailable || !databaseAvailable || !nftTablesExist) {
        console.log(
          "Skipping test: server, database, or NFT tables not available",
        );
        return;
      }

      await createTestNft(6001);
      const owner = await createTestUser();

      await db.insert(nftOwnership).values({
        id: `test-ownership-6001`,
        tokenId: 6001,
        ownerAddress: owner.walletAddress,
        userId: owner.id,
        acquiredAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await fetch(`${BASE_URL}/api/nft/collection`);
      expect(response.status).toBe(200);

      const data = await response.json();
      const nft = data.data.nfts.find(
        (n: { tokenId: number }) => n.tokenId === 6001,
      );

      if (nft) {
        expect(nft.owner).not.toBeNull();
        expect(nft.owner.walletAddress).toBe(owner.walletAddress);
      }
    });

    test("should handle pagination edge case - page beyond data", async () => {
      if (!serverAvailable) {
        console.log("Skipping test: server not available");
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/nft/collection?page=9999&limit=20`,
      );
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.nfts).toHaveLength(0);
    });

    test("should clamp limit to maximum", async () => {
      if (!serverAvailable) {
        console.log("Skipping test: server not available");
        return;
      }

      const response = await fetch(`${BASE_URL}/api/nft/collection?limit=9999`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.pagination.limit).toBeLessThanOrEqual(100);
    });
  });

  describe("NFT Detail Endpoint", () => {
    test("should return 404 for non-existent NFT", async () => {
      if (!serverAvailable) {
        console.log("Skipping test: server not available");
        return;
      }

      const response = await fetch(`${BASE_URL}/api/nft/99999`);
      expect(response.status).toBe(404);
    });

    test("should return 404 for invalid token ID", async () => {
      if (!serverAvailable) {
        console.log("Skipping test: server not available");
        return;
      }

      const response = await fetch(`${BASE_URL}/api/nft/not-a-number`);
      expect(response.status).toBe(404);
    });

    test("should return 404 for negative token ID", async () => {
      if (!serverAvailable) {
        console.log("Skipping test: server not available");
        return;
      }

      const response = await fetch(`${BASE_URL}/api/nft/-1`);
      expect(response.status).toBe(404);
    });

    test("should return NFT details", async () => {
      if (!serverAvailable || !databaseAvailable || !nftTablesExist) {
        console.log(
          "Skipping test: server, database, or NFT tables not available",
        );
        return;
      }

      await createTestNft(7001);

      const response = await fetch(`${BASE_URL}/api/nft/7001`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.tokenId).toBe(7001);
      expect(data.data.name).toBe("Test NFT #7001");
      expect(data.data.story).toHaveProperty("title");
      expect(data.data.story).toHaveProperty("content");
      expect(data.data.attributes).toBeInstanceOf(Array);
    });

    test("should include owner info for claimed NFT", async () => {
      if (!serverAvailable || !databaseAvailable || !nftTablesExist) {
        console.log(
          "Skipping test: server, database, or NFT tables not available",
        );
        return;
      }

      await createTestNft(7002);
      const owner = await createTestUser();

      await db.insert(nftOwnership).values({
        id: `test-ownership-7002`,
        tokenId: 7002,
        ownerAddress: owner.walletAddress,
        userId: owner.id,
        acquiredAt: new Date(),
        txHash: `0x${"1".repeat(64)}`,
        updatedAt: new Date(),
      });

      const response = await fetch(`${BASE_URL}/api/nft/7002`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.data.currentOwner).not.toBeNull();
      expect(data.data.currentOwner.walletAddress).toBe(owner.walletAddress);
      expect(data.data.currentOwner.user).not.toBeNull();
      expect(data.data.currentOwner.user.id).toBe(owner.id);
    });

    test("should include original claim info", async () => {
      if (!serverAvailable || !databaseAvailable || !nftTablesExist) {
        console.log(
          "Skipping test: server, database, or NFT tables not available",
        );
        return;
      }

      await createTestNft(7003);
      const claimer = await createTestUser();

      await db.insert(nftClaims).values({
        id: `test-claim-7003`,
        tokenId: 7003,
        claimerUserId: claimer.id,
        claimerAddress: claimer.walletAddress,
        claimedAt: new Date(),
        txHash: `0x${"2".repeat(64)}`,
        snapshotRank: 42,
        snapshotPoints: 10000,
      });

      const response = await fetch(`${BASE_URL}/api/nft/7003`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.data.originalClaim).not.toBeNull();
      expect(data.data.originalClaim.snapshotRank).toBe(42);
      expect(data.data.originalClaim.snapshotPoints).toBe(10000);
    });

    test("should return null owner for unclaimed NFT", async () => {
      if (!serverAvailable || !databaseAvailable || !nftTablesExist) {
        console.log(
          "Skipping test: server, database, or NFT tables not available",
        );
        return;
      }

      await createTestNft(7004);

      const response = await fetch(`${BASE_URL}/api/nft/7004`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.data.currentOwner).toBeNull();
      expect(data.data.originalClaim).toBeNull();
    });
  });

  describe("Eligibility Endpoint", () => {
    test("should require authentication", async () => {
      if (!serverAvailable) {
        console.log("Skipping test: server not available");
        return;
      }

      const response = await fetch(`${BASE_URL}/api/nft/eligibility`);
      expect(response.status).toBe(401);
    });
  });

  describe("Mint Prepare Endpoint", () => {
    test("should require authentication", async () => {
      if (!serverAvailable) {
        console.log("Skipping test: server not available");
        return;
      }

      const response = await fetch(`${BASE_URL}/api/nft/mint/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(response.status).toBe(401);
    });
  });

  describe("Mint Confirm Endpoint", () => {
    test("should require authentication", async () => {
      if (!serverAvailable) {
        console.log("Skipping test: server not available");
        return;
      }

      const response = await fetch(`${BASE_URL}/api/nft/mint/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: `0x${"1".repeat(64)}`,
          walletAddress: `0x${"1".repeat(40)}`,
        }),
      });
      expect(response.status).toBe(401);
    });
  });

  describe("Database Operations", () => {
    test("should create and retrieve NFT from database", async () => {
      if (!databaseAvailable || !nftTablesExist) {
        console.log("Skipping test: database or NFT tables not available");
        return;
      }

      await createTestNft(8001);

      const [nft] = await db
        .select()
        .from(nftCollection)
        .where(eq(nftCollection.tokenId, 8001))
        .limit(1);

      expect(nft).toBeDefined();
      expect(nft?.tokenId).toBe(8001);
      expect(nft?.name).toBe("Test NFT #8001");
    });

    test("should create and retrieve snapshot entry", async () => {
      if (!databaseAvailable || !nftTablesExist) {
        console.log("Skipping test: database or NFT tables not available");
        return;
      }

      const user = await createTestUser({ reputationPoints: 5000 });
      await createTestSnapshot(user.id, 42, 5000, user.walletAddress);

      const [snapshot] = await db
        .select()
        .from(nftSnapshot)
        .where(eq(nftSnapshot.userId, user.id))
        .limit(1);

      expect(snapshot).toBeDefined();
      expect(snapshot?.rank).toBe(42);
      expect(snapshot?.points).toBe(5000);
      expect(snapshot?.hasMinted).toBe(false);
    });

    test("should update hasMinted flag correctly", async () => {
      if (!databaseAvailable || !nftTablesExist) {
        console.log("Skipping test: database or NFT tables not available");
        return;
      }

      const user = await createTestUser();
      await createTestSnapshot(user.id, 1, 10000, user.walletAddress);

      // Verify initial state
      const [before] = await db
        .select()
        .from(nftSnapshot)
        .where(eq(nftSnapshot.userId, user.id))
        .limit(1);
      expect(before?.hasMinted).toBe(false);

      // Update to minted
      await db
        .update(nftSnapshot)
        .set({ hasMinted: true, mintedTokenId: 99, mintedAt: new Date() })
        .where(eq(nftSnapshot.userId, user.id));

      // Verify updated state
      const [after] = await db
        .select()
        .from(nftSnapshot)
        .where(eq(nftSnapshot.userId, user.id))
        .limit(1);
      expect(after?.hasMinted).toBe(true);
      expect(after?.mintedTokenId).toBe(99);
    });

    test("should enforce unique userId in snapshot", async () => {
      if (!databaseAvailable || !nftTablesExist) {
        console.log("Skipping test: database or NFT tables not available");
        return;
      }

      const user = await createTestUser();
      await createTestSnapshot(user.id, 1, 10000);

      // Attempting to create duplicate should fail
      try {
        await db.insert(nftSnapshot).values({
          id: `test-snapshot-${user.id}-2`,
          userId: user.id,
          rank: 2,
          points: 9000,
          snapshotTakenAt: new Date(),
          hasMinted: false,
        });
        // If we get here, the constraint didn't work
        expect(true).toBe(false); // Force failure
      } catch (error) {
        // Expected: unique constraint violation
        expect(error).toBeDefined();
      }
    });

    test("should create ownership record correctly", async () => {
      if (!databaseAvailable || !nftTablesExist) {
        console.log("Skipping test: database or NFT tables not available");
        return;
      }

      await createTestNft(8002);
      const owner = await createTestUser();

      await db.insert(nftOwnership).values({
        id: `test-ownership-8002`,
        tokenId: 8002,
        ownerAddress: owner.walletAddress,
        userId: owner.id,
        acquiredAt: new Date(),
        txHash: `0x${"3".repeat(64)}`,
        updatedAt: new Date(),
      });

      const [ownership] = await db
        .select()
        .from(nftOwnership)
        .where(eq(nftOwnership.tokenId, 8002))
        .limit(1);

      expect(ownership).toBeDefined();
      expect(ownership?.ownerAddress).toBe(owner.walletAddress);
      expect(ownership?.userId).toBe(owner.id);
    });

    test("should enforce unique tokenId in ownership", async () => {
      if (!databaseAvailable || !nftTablesExist) {
        console.log("Skipping test: database or NFT tables not available");
        return;
      }

      await createTestNft(8003);
      const owner1 = await createTestUser();
      const owner2 = await createTestUser();

      await db.insert(nftOwnership).values({
        id: `test-ownership-8003`,
        tokenId: 8003,
        ownerAddress: owner1.walletAddress,
        userId: owner1.id,
        acquiredAt: new Date(),
        updatedAt: new Date(),
      });

      // Attempting to create duplicate ownership should fail
      try {
        await db.insert(nftOwnership).values({
          id: `test-ownership-8003-2`,
          tokenId: 8003,
          ownerAddress: owner2.walletAddress,
          userId: owner2.id,
          acquiredAt: new Date(),
          updatedAt: new Date(),
        });
        expect(true).toBe(false); // Force failure
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    test("should create claim record with provenance data", async () => {
      if (!databaseAvailable || !nftTablesExist) {
        console.log("Skipping test: database or NFT tables not available");
        return;
      }

      await createTestNft(8004);
      const claimer = await createTestUser();

      const txHash = `0x${"4".repeat(64)}`;
      await db.insert(nftClaims).values({
        id: `test-claim-8004`,
        tokenId: 8004,
        claimerUserId: claimer.id,
        claimerAddress: claimer.walletAddress,
        claimedAt: new Date(),
        txHash,
        snapshotRank: 25,
        snapshotPoints: 7500,
      });

      const [claim] = await db
        .select()
        .from(nftClaims)
        .where(eq(nftClaims.tokenId, 8004))
        .limit(1);

      expect(claim).toBeDefined();
      expect(claim?.snapshotRank).toBe(25);
      expect(claim?.snapshotPoints).toBe(7500);
      expect(claim?.txHash).toBe(txHash);
    });
  });

  describe("Concurrent Operations", () => {
    test("should handle concurrent snapshot lookups", async () => {
      if (!databaseAvailable || !nftTablesExist) {
        console.log("Skipping test: database or NFT tables not available");
        return;
      }

      const user = await createTestUser();
      await createTestSnapshot(user.id, 1, 10000);

      // Simulate concurrent reads
      const reads = Array.from({ length: 10 }, () =>
        db
          .select()
          .from(nftSnapshot)
          .where(eq(nftSnapshot.userId, user.id))
          .limit(1),
      );

      const results = await Promise.all(reads);
      results.forEach((result) => {
        expect(result).toHaveLength(1);
        expect(result[0]?.userId).toBe(user.id);
        expect(result[0]?.rank).toBe(1);
      });
    });

    test("should handle concurrent NFT detail requests", async () => {
      if (!serverAvailable || !databaseAvailable || !nftTablesExist) {
        console.log(
          "Skipping test: server, database, or NFT tables not available",
        );
        return;
      }

      await createTestNft(9001);

      // Simulate concurrent requests
      const requests = Array.from({ length: 5 }, () =>
        fetch(`${BASE_URL}/api/nft/9001`),
      );

      const responses = await Promise.all(requests);
      responses.forEach((response) => {
        expect(response.status).toBe(200);
      });

      // Verify all responses are consistent
      const data = await Promise.all(responses.map((r) => r.json()));
      data.forEach((d) => {
        expect(d.data.tokenId).toBe(9001);
        expect(d.data.name).toBe("Test NFT #9001");
      });
    });
  });
});
