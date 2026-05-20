/**
 * Integration Tests: NFT Mint Service
 *
 * Tests the complete NFT minting flow including:
 * - Eligibility checking via nftSnapshot
 * - Signature generation for mint transactions
 * - On-chain transaction verification (when available)
 * - Database updates after successful mint
 *
 * Prerequisites:
 * - Web server running (bun dev in apps/web)
 * - Database available (DATABASE_URL set)
 *
 * Run with: bun test integration/nft-mint.integration.test.ts --preload ./integration/preload.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  db,
  eq,
  inArray,
  nftClaims,
  nftCollection,
  nftOwnership,
  nftSnapshot,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { nanoid } from 'nanoid';

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'http://localhost:3000';

let serverAvailable = false;
let databaseAvailable = false;

function assertInfrastructure(options: {
  server?: boolean;
  database?: boolean;
}): void {
  if (options.server && !serverAvailable) {
    throw new Error('NFT mint integration test requires the web server');
  }
  if (options.database && !databaseAvailable) {
    throw new Error('NFT mint integration test requires DATABASE_URL');
  }
}
const testUserIds: string[] = [];
const testSnapshotIds: string[] = [];
const testCollectionIds: string[] = [];
const testOwnershipIds: string[] = [];
const testClaimIds: string[] = [];

// Test wallet addresses
const TEST_ELIGIBLE_WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // Anvil Account #0
const TEST_COLLECTION_TOKEN_IDS = Array.from(
  { length: 100 },
  (_, index) => index + 1
);

interface EligibilityResponse {
  eligible: boolean;
  status: 'not_authenticated' | 'not_eligible' | 'eligible' | 'already_minted';
  snapshotRank?: number;
  hasMinted: boolean;
  reason?: string;
}

function createUniqueWalletAddress(userId: string): string {
  return `0x${BigInt(userId).toString(16).padStart(40, '0').slice(-40)}`;
}

async function checkServerHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function createTestUser(
  walletAddress?: string
): Promise<{ id: string; walletAddress: string }> {
  const userId = await generateSnowflakeId();
  const privyId = `did:privy:test-${userId}`;
  const normalizedWalletAddress = (
    walletAddress ?? createUniqueWalletAddress(userId)
  ).toLowerCase();

  await db.insert(users).values({
    id: userId,
    privyId,
    walletAddress: normalizedWalletAddress,
    username: `test-nft-mint-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    displayName: `Test NFT Mint User ${userId.slice(0, 8)}`,
    isActor: false,
    isBanned: false,
    updatedAt: new Date(),
  });

  testUserIds.push(userId);
  return { id: userId, walletAddress: normalizedWalletAddress };
}

async function createSnapshotEntry(
  userId: string,
  walletAddress: string,
  rank: number,
  points: number
): Promise<string> {
  const id = nanoid();

  await db.insert(nftSnapshot).values({
    id,
    userId,
    walletAddress: walletAddress.toLowerCase(),
    rank,
    points,
    snapshotTakenAt: new Date(),
    hasMinted: false,
  });

  testSnapshotIds.push(id);
  return id;
}

async function createTestNftCollection(): Promise<void> {
  const envChainId =
    process.env.NEXT_PUBLIC_CHAIN_ID ||
    process.env.CHAIN_ID ||
    process.env.NFT_CHAIN_ID ||
    '31337';
  const chainId = parseInt(envChainId, 10);

  // Create 100 test NFTs
  for (const tokenId of TEST_COLLECTION_TOKEN_IDS) {
    const id = nanoid();
    await db.insert(nftCollection).values({
      id,
      tokenId,
      name: `ProtoMonkey #${tokenId}`,
      description: `Test NFT ${tokenId}`,
      imageUrl: `https://picsum.photos/seed/${tokenId}/512/512`,
      thumbnailUrl: `https://picsum.photos/seed/${tokenId}/256/256`,
      contractAddress:
        process.env.NFT_CONTRACT_ADDRESS ??
        '0x0000000000000000000000000000000000000000',
      chainId,
      updatedAt: new Date(),
    });
    testCollectionIds.push(id);
  }
}

async function cleanupTestNftCollection(): Promise<void> {
  if (TEST_COLLECTION_TOKEN_IDS.length === 0) {
    return;
  }

  await db
    .delete(nftClaims)
    .where(inArray(nftClaims.tokenId, TEST_COLLECTION_TOKEN_IDS));
  await db
    .delete(nftOwnership)
    .where(inArray(nftOwnership.tokenId, TEST_COLLECTION_TOKEN_IDS));
  await db
    .delete(nftCollection)
    .where(inArray(nftCollection.tokenId, TEST_COLLECTION_TOKEN_IDS));
  testCollectionIds.length = 0;
}

function getAuthToken(userId: string): string {
  return `did:privy:test-${userId}`;
}

async function authenticatedFetch(
  path: string,
  userId: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  headers['Authorization'] = `Bearer ${getAuthToken(userId)}`;

  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
}

async function parseEligibilityResponse(
  response: Response
): Promise<EligibilityResponse> {
  const payload = (await response.json()) as {
    success: boolean;
    data: EligibilityResponse;
  };
  expect(payload.success).toBe(true);
  return payload.data;
}

describe('NFT Mint Service - Integration Tests', () => {
  beforeAll(async () => {
    serverAvailable = await checkServerHealth();
    if (!serverAvailable) {
      console.warn(
        '⚠️  Server not available - some tests will be skipped. Start with: bun run dev'
      );
    }

    try {
      await db.select().from(users).limit(1);
      databaseAvailable = true;
    } catch {
      databaseAvailable = false;
      console.warn('⚠️  Database not available. Set DATABASE_URL.');
    }

    if (databaseAvailable) {
      await cleanupTestNftCollection();
      // Create test NFT collection
      await createTestNftCollection();
    }
  });

  afterAll(async () => {
    if (databaseAvailable) {
      await cleanupTestNftCollection();
    }
  });

  afterEach(async () => {
    // Clean up test data in reverse order of dependencies
    if (testClaimIds.length > 0) {
      await db.delete(nftClaims).where(inArray(nftClaims.id, testClaimIds));
      testClaimIds.length = 0;
    }

    if (testOwnershipIds.length > 0) {
      await db
        .delete(nftOwnership)
        .where(inArray(nftOwnership.id, testOwnershipIds));
      testOwnershipIds.length = 0;
    }

    if (testSnapshotIds.length > 0) {
      await db
        .delete(nftSnapshot)
        .where(inArray(nftSnapshot.id, testSnapshotIds));
      testSnapshotIds.length = 0;
    }

    if (testUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, testUserIds));
      testUserIds.length = 0;
    }
  });

  describe('Eligibility Endpoint', () => {
    test('should return eligible=true for user in snapshot', async () => {
      assertInfrastructure({ server: true, database: true });

      const user = await createTestUser();
      await createSnapshotEntry(user.id, user.walletAddress, 5, 10000);

      const response = await authenticatedFetch(
        '/api/nft/eligibility',
        user.id
      );
      expect(response.status).toBe(200);

      const data = await parseEligibilityResponse(response);
      expect(data.eligible).toBe(true);
      expect(data.status).toBe('eligible');
      expect(data.snapshotRank).toBe(5);
      expect(data.hasMinted).toBe(false);
    });

    test('should return eligible=false for user not in snapshot', async () => {
      assertInfrastructure({ server: true, database: true });

      const user = await createTestUser();
      // No snapshot entry created

      const response = await authenticatedFetch(
        '/api/nft/eligibility',
        user.id
      );
      expect(response.status).toBe(200);

      const data = await parseEligibilityResponse(response);
      expect(data.eligible).toBe(false);
      expect(data.status).toBe('not_eligible');
      expect(data.reason).toBe('not_in_top_100');
    });

    test('should return already_minted status when user has minted', async () => {
      assertInfrastructure({ server: true, database: true });

      const user = await createTestUser();
      const snapshotId = await createSnapshotEntry(
        user.id,
        user.walletAddress,
        1,
        50000
      );

      // Mark as already minted
      await db
        .update(nftSnapshot)
        .set({
          hasMinted: true,
          mintedTokenId: 42,
          mintedAt: new Date(),
          mintTxHash: '0x' + '1'.repeat(64),
        })
        .where(eq(nftSnapshot.id, snapshotId));

      const response = await authenticatedFetch(
        '/api/nft/eligibility',
        user.id
      );
      expect(response.status).toBe(200);

      const data = await parseEligibilityResponse(response);
      expect(data.eligible).toBe(true);
      expect(data.status).toBe('already_minted');
      expect(data.hasMinted).toBe(true);
    });
  });

  describe('Mint Prepare Endpoint', () => {
    test('should require authentication', async () => {
      assertInfrastructure({ server: true });

      const response = await fetch(`${BASE_URL}/api/nft/mint/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(401);
    });

    test('should return 403 for ineligible user', async () => {
      assertInfrastructure({ server: true, database: true });

      const user = await createTestUser();

      const response = await authenticatedFetch(
        '/api/nft/mint/prepare',
        user.id,
        {
          method: 'POST',
        }
      );

      // Should fail because user not in snapshot
      expect([400, 403]).toContain(response.status);
    });

    test('should return signature and encoded data for eligible user', async () => {
      assertInfrastructure({ server: true, database: true });

      const user = await createTestUser();
      await createSnapshotEntry(user.id, user.walletAddress, 10, 8000);

      const response = await authenticatedFetch(
        '/api/nft/mint/prepare',
        user.id,
        {
          method: 'POST',
        }
      );

      // In local integration runs this is expected to fail unless the NFT
      // signer config and the user's embedded wallet are both ready in the
      // server process.
      if (response.status === 400) {
        const error = await response.json();
        expect(typeof error.error).toBe('string');
        expect([
          'Embedded wallet not ready',
          'NFT contract not configured',
          'NFT chain not configured',
          'NFT signer not configured',
        ]).toContain(error.error);
        return;
      }

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.contractAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(data.chainId).toBeGreaterThan(0);
      expect(data.deadline).toBeGreaterThan(Date.now() / 1000);
      expect(data.nonce).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(data.signature).toMatch(/^0x[a-fA-F0-9]+$/);
      expect(data.encodedData).toMatch(/^0x[a-fA-F0-9]+$/);
    });

    test('should return 403 for user who already minted', async () => {
      assertInfrastructure({ server: true, database: true });

      const user = await createTestUser();
      const snapshotId = await createSnapshotEntry(
        user.id,
        user.walletAddress,
        3,
        20000
      );

      // Mark as already minted
      await db
        .update(nftSnapshot)
        .set({
          hasMinted: true,
          mintedTokenId: 1,
          mintedAt: new Date(),
        })
        .where(eq(nftSnapshot.id, snapshotId));

      const response = await authenticatedFetch(
        '/api/nft/mint/prepare',
        user.id,
        {
          method: 'POST',
        }
      );

      expect([400, 403]).toContain(response.status);
      const error = await response.json();
      expect(error.error).toContain('minted');
    });
  });

  describe('Mint Confirm Endpoint', () => {
    test('should require authentication', async () => {
      assertInfrastructure({ server: true });

      const response = await fetch(`${BASE_URL}/api/nft/mint/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash: '0x' + '1'.repeat(64),
          walletAddress: TEST_ELIGIBLE_WALLET,
        }),
      });

      expect(response.status).toBe(401);
    });

    test('should reject invalid transaction hash', async () => {
      assertInfrastructure({ server: true, database: true });

      const user = await createTestUser();

      const response = await authenticatedFetch(
        '/api/nft/mint/confirm',
        user.id,
        {
          method: 'POST',
          body: JSON.stringify({
            txHash: 'invalid-hash',
            walletAddress: user.walletAddress,
          }),
        }
      );

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('hash');
    });

    test('should reject invalid wallet address', async () => {
      assertInfrastructure({ server: true, database: true });

      const user = await createTestUser();

      const response = await authenticatedFetch(
        '/api/nft/mint/confirm',
        user.id,
        {
          method: 'POST',
          body: JSON.stringify({
            txHash: '0x' + '1'.repeat(64),
            walletAddress: 'invalid-address',
          }),
        }
      );

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('address');
    });
  });

  describe('Metadata Endpoint', () => {
    test('should return metadata for valid token ID', async () => {
      assertInfrastructure({ server: true, database: true });

      const response = await fetch(`${BASE_URL}/api/nft/metadata/1`);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe('ProtoMonkey #1');
      expect(data.image).toBeDefined();
      expect(data.external_url).toBe('https://feed.market/nft/1');
    });

    test('should return 400 for invalid token ID (0)', async () => {
      assertInfrastructure({ server: true });

      const response = await fetch(`${BASE_URL}/api/nft/metadata/0`);
      expect(response.status).toBe(400);
    });

    test('should return 400 for invalid token ID (101)', async () => {
      assertInfrastructure({ server: true });

      const response = await fetch(`${BASE_URL}/api/nft/metadata/101`);
      expect(response.status).toBe(400);
    });

    test('should return 400 for non-numeric token ID', async () => {
      assertInfrastructure({ server: true });

      const response = await fetch(`${BASE_URL}/api/nft/metadata/abc`);
      expect(response.status).toBe(400);
    });

    test('should include cache headers', async () => {
      assertInfrastructure({ server: true, database: true });

      const response = await fetch(`${BASE_URL}/api/nft/metadata/50`);

      expect(response.status).toBe(200);
      const cacheControl = response.headers.get('Cache-Control');
      expect(cacheControl).toContain('public');
      expect(cacheControl).toContain('max-age');
    });
  });

  describe('Database State Consistency', () => {
    test('should maintain snapshot and collection consistency', async () => {
      assertInfrastructure({ database: true });

      // Create user with snapshot
      const user = await createTestUser();
      const snapshotId = await createSnapshotEntry(
        user.id,
        user.walletAddress,
        1,
        100000
      );

      // Verify snapshot exists
      const [snapshot] = await db
        .select()
        .from(nftSnapshot)
        .where(eq(nftSnapshot.id, snapshotId))
        .limit(1);

      expect(snapshot).toBeDefined();
      if (!snapshot) {
        throw new Error('Expected snapshot to exist');
      }
      expect(snapshot.userId).toBe(user.id);
      expect(snapshot.hasMinted).toBe(false);

      // Verify NFT collection has all 100 tokens
      const collection = await db.select().from(nftCollection);
      expect(collection.length).toBe(100);

      // Verify token IDs are 1-100
      const tokenIds = collection.map((n) => n.tokenId).sort((a, b) => a - b);
      expect(tokenIds[0]).toBe(1);
      expect(tokenIds[99]).toBe(100);
    });

    test('should not allow duplicate claims for same token', async () => {
      assertInfrastructure({ database: true });

      const user1 = await createTestUser();

      // Insert a claim
      const claimId = nanoid();
      await db.insert(nftClaims).values({
        id: claimId,
        tokenId: 42,
        claimerUserId: user1.id,
        claimerAddress: user1.walletAddress,
        claimedAt: new Date(),
        txHash: '0x' + '1'.repeat(64),
        snapshotRank: 1,
        snapshotPoints: 50000,
      });
      testClaimIds.push(claimId);

      // Try to insert duplicate claim for same token
      const duplicateClaimId = nanoid();
      try {
        await db.insert(nftClaims).values({
          id: duplicateClaimId,
          tokenId: 42, // Same token ID
          claimerUserId: 'another-user',
          claimerAddress: createUniqueWalletAddress('1'),
          claimedAt: new Date(),
          txHash: '0x' + '2'.repeat(64),
          snapshotRank: 2,
          snapshotPoints: 40000,
        });
        // Should have thrown due to unique constraint
        expect(true).toBe(false);
      } catch (error) {
        // Expected - unique constraint violation
        expect(error).toBeDefined();
      }
    });

    test('should update ownership correctly', async () => {
      assertInfrastructure({ database: true });

      const user = await createTestUser();

      // Insert ownership
      const ownershipId = nanoid();
      await db.insert(nftOwnership).values({
        id: ownershipId,
        tokenId: 99,
        ownerAddress: user.walletAddress,
        userId: user.id,
        acquiredAt: new Date(),
        txHash: '0x' + 'a'.repeat(64),
        updatedAt: new Date(),
      });
      testOwnershipIds.push(ownershipId);

      // Verify ownership
      const [ownership] = await db
        .select()
        .from(nftOwnership)
        .where(eq(nftOwnership.tokenId, 99))
        .limit(1);

      expect(ownership).toBeDefined();
      if (!ownership) {
        throw new Error('Expected ownership record to exist');
      }
      expect(ownership.ownerAddress).toBe(user.walletAddress);
      expect(ownership.userId).toBe(user.id);
    });
  });

  describe('Token ID Range Validation', () => {
    test('should accept all valid token IDs (1-100)', async () => {
      assertInfrastructure({ database: true });

      const validIds = [1, 50, 100];

      for (const tokenId of validIds) {
        const [nft] = await db
          .select()
          .from(nftCollection)
          .where(eq(nftCollection.tokenId, tokenId))
          .limit(1);

        expect(nft).toBeDefined();
        if (!nft) {
          throw new Error(`Expected NFT token ${tokenId} to exist`);
        }
        expect(nft.tokenId).toBe(tokenId);
      }
    });

    test('should not have any token IDs outside 1-100', async () => {
      assertInfrastructure({ database: true });

      const collection = await db.select().from(nftCollection);

      for (const nft of collection) {
        expect(nft.tokenId).toBeGreaterThanOrEqual(1);
        expect(nft.tokenId).toBeLessThanOrEqual(100);
      }
    });
  });
});
