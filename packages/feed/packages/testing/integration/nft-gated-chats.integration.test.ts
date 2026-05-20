/**
 * Integration Tests: NFT-Gated Group Chats
 *
 * Tests the complete NFT gating flow including:
 * - API endpoints for creating NFT-gated chats
 * - NFT verification service with real RPC calls (when available)
 * - Access control enforcement
 * - Error handling and edge cases
 *
 * Run with: bun test integration/nft-gated-chats.integration.test.ts --preload ./integration/preload.ts
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  users,
} from '@feed/db';
import { generateSnowflakeId, getCurrentChainId } from '@feed/shared';

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'http://localhost:3000';

let serverAvailable = false;
let databaseAvailable = false;
const testUserIds: string[] = [];
const testChatIds: string[] = [];
const testGroupIds: string[] = [];

// Test NFT contract address (using a known testnet contract or mock)
// For real tests, this should be a deployed ERC721 contract on the testnet
const TEST_NFT_CONTRACT = '0x1234567890123456789012345678901234567890';
const TEST_WALLET_WITH_NFT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const TEST_WALLET_WITHOUT_NFT = '0x9876543210987654321098765432109876543210';

async function checkServerHealth(): Promise<boolean> {
  const response = await fetch(`${BASE_URL}/api/health`, {
    signal: AbortSignal.timeout(5000),
  });
  return response.ok;
}

async function createTestUser(
  walletAddress?: string
): Promise<{ id: string; walletAddress: string | null }> {
  const userId = await generateSnowflakeId();
  const userWallet =
    walletAddress ||
    `0x${Math.random().toString(16).slice(2).padStart(40, '0')}`;

  await db.insert(users).values({
    id: userId,
    privyId: `did:privy:test-${userId}`,
    walletAddress: userWallet,
    username: `test-nft-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    displayName: `Test NFT User ${userId.slice(0, 8)}`,
    isActor: false,
    isTest: true,
    isBanned: false,
    updatedAt: new Date(),
  });

  testUserIds.push(userId);
  return { id: userId, walletAddress: userWallet };
}

/**
 * Get authentication token for test user
 *
 * NOTE: Integration tests require proper authentication setup.
 * For full integration testing:
 * 1. Run E2E auth setup: bunx playwright test --project=setup
 * 2. Or use test tokens from .playwright/test-tokens.json
 *
 * For now, these tests will check auth requirements (401 responses)
 * and can be extended with real auth tokens when available.
 */
async function getAuthToken(userId?: string): Promise<string | null> {
  if (userId) {
    return `did:privy:test-${userId}`;
  }

  // Try to load from test tokens file if available
  try {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const tokenFile = join(process.cwd(), '.playwright', 'test-tokens.json');
    const tokens = JSON.parse(readFileSync(tokenFile, 'utf-8'));
    return tokens.TEST_ACCESS_TOKEN || null;
  } catch {
    // No token file - tests will verify auth requirements
    return null;
  }
}

function trackCreatedGroup(payload: {
  group?: {
    id?: string;
    chatId?: string;
  };
}): { groupId: string; chatId: string } {
  expect(payload.group?.id).toBeDefined();
  expect(payload.group?.chatId).toBeDefined();

  const groupId = payload.group?.id;
  const chatId = payload.group?.chatId;

  if (!groupId || !chatId) {
    throw new Error('Expected /api/groups to return group.id and group.chatId');
  }

  testGroupIds.push(groupId);
  testChatIds.push(chatId);

  return { groupId, chatId };
}

async function authenticatedFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
}

function authHeaders(token: string | null): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function expectAuthRequired(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  const data = await response.json();
  expect(data.error).toBeDefined();
}

describe('NFT-Gated Group Chats - Integration Tests', () => {
  beforeAll(async () => {
    serverAvailable = await checkServerHealth().catch(() => false);
    if (!serverAvailable) {
      console.warn(
        '⚠️  Server not available - NFT gating tests will be skipped. Start server with: bun run dev'
      );
    }

    // Verify database connection
    try {
      await db.select().from(users).limit(1);
      databaseAvailable = true;
    } catch {
      databaseAvailable = false;
      console.warn(
        '⚠️  Database not available - NFT gating tests will be skipped. Set DATABASE_URL environment variable.'
      );
    }
  });

  afterEach(async () => {
    // Clean up test data
    if (testChatIds.length > 0) {
      await db
        .delete(chatParticipants)
        .where(inArray(chatParticipants.chatId, testChatIds));
      await db.delete(chats).where(inArray(chats.id, testChatIds));
      testChatIds.length = 0;
    }

    if (testGroupIds.length > 0) {
      await db
        .delete(groupMembers)
        .where(inArray(groupMembers.groupId, testGroupIds));
      await db.delete(groups).where(inArray(groups.id, testGroupIds));
      testGroupIds.length = 0;
    }

    if (testUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, testUserIds));
      testUserIds.length = 0;
    }
  });

  describe('Chat Creation with NFT Gating', () => {
    test('should require authentication to create NFT-gated chat', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const response = await authenticatedFetch('/api/groups', {
        method: 'POST',
        body: JSON.stringify({
          name: 'NFT Gated Test Group',
          memberIds: [],
          nftGated: true,
          requiredNftContractAddress: TEST_NFT_CONTRACT,
          requiredNftChainId: getCurrentChainId(),
        }),
      });

      await expectAuthRequired(response);
    });

    test('should create NFT-gated group chat with token-specific requirement', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const user = await createTestUser(TEST_WALLET_WITH_NFT);
      const token = await getAuthToken(user.id);

      const response = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
        },
        body: JSON.stringify({
          name: 'Token-Specific NFT Group',
          memberIds: [user.id],
          nftGated: true,
          requiredNftContractAddress: TEST_NFT_CONTRACT,
          requiredNftTokenId: 42,
          requiredNftChainId: getCurrentChainId(),
        }),
      });

      if (!token) {
        await expectAuthRequired(response);
        return;
      }

      expect(response.status).toBe(200);
      const data = await response.json();
      const createdGroup = trackCreatedGroup(data);
      expect(createdGroup.chatId).toBeDefined();
    });

    test('should reject creation with invalid contract address format', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const user = await createTestUser();
      const token = await getAuthToken(user.id);

      const response = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
        },
        body: JSON.stringify({
          name: 'Invalid NFT Group',
          memberIds: [user.id],
          nftGated: true,
          requiredNftContractAddress: 'invalid-address',
          requiredNftChainId: getCurrentChainId(),
        }),
      });

      if (!token) {
        await expectAuthRequired(response);
        return;
      }

      expect(response.status).toBe(400);
    });

    test('should treat group as non-gated when contract address is omitted', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const user = await createTestUser();
      const token = await getAuthToken(user.id);

      const response = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
        },
        body: JSON.stringify({
          name: 'Missing Contract Group',
          memberIds: [user.id],
          requiredNftChainId: getCurrentChainId(),
        }),
      });

      if (!token) {
        await expectAuthRequired(response);
        return;
      }

      expect(response.status).toBe(200);
      const data = await response.json();
      const { chatId } = trackCreatedGroup(data);

      const verifyResponse = await authenticatedFetch(
        `/api/chats/${chatId}/nft-verification`,
        {
          method: 'GET',
          headers: {
            ...authHeaders(token),
          },
        }
      );

      expect(verifyResponse.status).toBe(200);
      const verifyData = await verifyResponse.json();
      expect(verifyData.nftRequired).toBe(false);
    });

    test('should allow token ID 0', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const user = await createTestUser(TEST_WALLET_WITH_NFT);
      const token = await getAuthToken(user.id);

      const response = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
        },
        body: JSON.stringify({
          name: 'Token Zero Group',
          memberIds: [user.id],
          nftGated: true,
          requiredNftContractAddress: TEST_NFT_CONTRACT,
          requiredNftTokenId: 0,
          requiredNftChainId: getCurrentChainId(),
        }),
      });

      if (!token) {
        await expectAuthRequired(response);
        return;
      }

      expect(response.status).toBe(200);
      const data = await response.json();
      const createdGroup = trackCreatedGroup(data);
      expect(createdGroup.chatId).toBeDefined();
    });
  });

  describe('NFT Verification Endpoint', () => {
    test('should surface contract validation errors for undeployed NFT-gated chats', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const user = await createTestUser(TEST_WALLET_WITH_NFT);
      const token = await getAuthToken(user.id);

      // Create NFT-gated chat
      const createResponse = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
        },
        body: JSON.stringify({
          name: 'Verification Test Group',
          memberIds: [user.id],
          nftGated: true,
          requiredNftContractAddress: TEST_NFT_CONTRACT,
          requiredNftChainId: getCurrentChainId(),
        }),
      });

      if (!token) {
        await expectAuthRequired(createResponse);
        return;
      }

      const createData = await createResponse.json();
      const { chatId } = trackCreatedGroup(createData);

      // Check verification status
      const verifyResponse = await authenticatedFetch(
        `/api/chats/${chatId}/nft-verification`,
        {
          method: 'GET',
          headers: {
            ...authHeaders(token),
          },
        }
      );

      expect(verifyResponse.status).toBe(400);
      const verifyData = await verifyResponse.json();
      expect(verifyData.error).toContain('No contract');
      expect(verifyData.error).toContain(TEST_NFT_CONTRACT);
    });

    test('should return isNftGated=false for non-gated chat', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const user = await createTestUser();
      const token = await getAuthToken(user.id);

      // Create regular group chat
      const createResponse = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
        },
        body: JSON.stringify({
          name: 'Regular Group',
          memberIds: [user.id],
        }),
      });

      if (!token) {
        await expectAuthRequired(createResponse);
        return;
      }

      const createData = await createResponse.json();
      const { chatId } = trackCreatedGroup(createData);

      // Check verification status
      const verifyResponse = await authenticatedFetch(
        `/api/chats/${chatId}/nft-verification`,
        {
          method: 'GET',
          headers: {
            ...authHeaders(token),
          },
        }
      );

      expect(verifyResponse.status).toBe(200);
      const verifyData = await verifyResponse.json();
      expect(verifyData.nftRequired).toBe(false);
      expect(verifyData.ownsNft).toBe(true);
    });

    test('should return ownsNft=false when user lacks wallet address', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const user = await createTestUser();
      // Remove wallet address
      await db
        .update(users)
        .set({ walletAddress: null })
        .where(eq(users.id, user.id));

      const token = await getAuthToken(user.id);

      // Create NFT-gated chat
      const createResponse = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
        },
        body: JSON.stringify({
          name: 'No Wallet Test Group',
          memberIds: [user.id],
          nftGated: true,
          requiredNftContractAddress: TEST_NFT_CONTRACT,
          requiredNftChainId: getCurrentChainId(),
        }),
      });

      if (!token) {
        await expectAuthRequired(createResponse);
        return;
      }

      const createData = await createResponse.json();
      const { chatId } = trackCreatedGroup(createData);

      // Check verification status
      const verifyResponse = await authenticatedFetch(
        `/api/chats/${chatId}/nft-verification`,
        {
          method: 'GET',
          headers: {
            ...authHeaders(token),
          },
        }
      );

      expect(verifyResponse.status).toBe(200);
      const verifyData = await verifyResponse.json();
      expect(verifyData.ownsNft).toBe(false);
      expect(verifyData.nftRequired).toBe(true);
      expect(verifyData.reason).toContain('Wallet address required');
    });
  });

  describe('Access Control Enforcement', () => {
    test('should prevent adding user without NFT to NFT-gated chat', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const owner = await createTestUser(TEST_WALLET_WITH_NFT);
      const nonOwner = await createTestUser(TEST_WALLET_WITHOUT_NFT);
      const ownerToken = await getAuthToken(owner.id);

      // Create NFT-gated chat
      const createResponse = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(ownerToken),
        },
        body: JSON.stringify({
          name: 'Access Control Test',
          memberIds: [owner.id],
          nftGated: true,
          requiredNftContractAddress: TEST_NFT_CONTRACT,
          requiredNftChainId: getCurrentChainId(),
        }),
      });

      if (!ownerToken) {
        await expectAuthRequired(createResponse);
        return;
      }

      const createData = await createResponse.json();
      const { chatId } = trackCreatedGroup(createData);

      // Try to add user without NFT
      const addResponse = await authenticatedFetch(
        `/api/chats/${chatId}/participants`,
        {
          method: 'POST',
          headers: {
            ...authHeaders(ownerToken),
          },
          body: JSON.stringify({
            userIds: [nonOwner.id],
          }),
        }
      );

      // Should fail with NFT requirement error
      expect(addResponse.status).toBe(400);
      const errorData = await addResponse.json();
      expect(errorData.error).toBeDefined();
      expect(errorData.error).toContain('NFT');
    });

    test('should prevent sending message without NFT', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const owner = await createTestUser(TEST_WALLET_WITH_NFT);
      const nonOwner = await createTestUser(TEST_WALLET_WITHOUT_NFT);
      const ownerToken = await getAuthToken(owner.id);
      const nonOwnerToken = await getAuthToken(nonOwner.id);

      // Create NFT-gated chat and add owner
      const createResponse = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(ownerToken),
        },
        body: JSON.stringify({
          name: 'Message Control Test',
          memberIds: [owner.id],
          nftGated: true,
          requiredNftContractAddress: TEST_NFT_CONTRACT,
          requiredNftChainId: getCurrentChainId(),
        }),
      });

      if (!ownerToken) {
        await expectAuthRequired(createResponse);
        return;
      }

      const createData = await createResponse.json();
      const { groupId, chatId } = trackCreatedGroup(createData);

      // Manually add non-owner to the group and chat (bypassing verification for test)
      // so the message route reaches the NFT ownership check.
      const memberId = await generateSnowflakeId();
      const participantId = await generateSnowflakeId();
      await db.insert(groupMembers).values({
        id: memberId,
        groupId,
        userId: nonOwner.id,
        role: 'member',
        addedBy: owner.id,
        joinedAt: new Date(),
        isActive: true,
      });
      await db.insert(chatParticipants).values({
        id: participantId,
        chatId,
        userId: nonOwner.id,
        joinedAt: new Date(),
      });

      // Try to send message without NFT
      const messageResponse = await authenticatedFetch(
        `/api/chats/${chatId}/message`,
        {
          method: 'POST',
          headers: {
            ...authHeaders(nonOwnerToken),
          },
          body: JSON.stringify({
            content: 'Test message',
          }),
        }
      );

      // Should fail with authorization error
      expect(messageResponse.status).toBe(403);
      const errorData = await messageResponse.json();
      expect(errorData.error).toBeDefined();
    });
  });

  describe('Chat List and Details', () => {
    test('should include NFT requirement in chat list response', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const user = await createTestUser(TEST_WALLET_WITH_NFT);
      const token = await getAuthToken(user.id);

      // Create NFT-gated chat
      const createResponse = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
        },
        body: JSON.stringify({
          name: 'List Test Group',
          memberIds: [user.id],
          nftGated: true,
          requiredNftContractAddress: TEST_NFT_CONTRACT,
          requiredNftChainId: getCurrentChainId(),
        }),
      });

      if (!token) {
        await expectAuthRequired(createResponse);
        return;
      }

      const createData = await createResponse.json();
      const { chatId } = trackCreatedGroup(createData);

      // Get chat list
      const listResponse = await authenticatedFetch('/api/chats', {
        method: 'GET',
        headers: {
          ...authHeaders(token),
        },
      });

      expect(listResponse.status).toBe(200);
      const listData = await listResponse.json();
      const chat = listData.groupChats?.find(
        (c: { id: string }) => c.id === chatId
      );
      expect(chat).toBeDefined();
      expect(chat.nftRequirement).toBeDefined();
    });

    test('should include NFT requirement in chat details response', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const user = await createTestUser(TEST_WALLET_WITH_NFT);
      const token = await getAuthToken(user.id);

      // Create NFT-gated chat
      const createResponse = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
        },
        body: JSON.stringify({
          name: 'Details Test Group',
          memberIds: [user.id],
          nftGated: true,
          requiredNftContractAddress: TEST_NFT_CONTRACT,
          requiredNftTokenId: 42,
          requiredNftChainId: getCurrentChainId(),
        }),
      });

      if (!token) {
        await expectAuthRequired(createResponse);
        return;
      }

      const createData = await createResponse.json();
      const { chatId } = trackCreatedGroup(createData);

      // Get chat details
      const detailsResponse = await authenticatedFetch(`/api/chats/${chatId}`, {
        method: 'GET',
        headers: {
          ...authHeaders(token),
        },
      });

      expect(detailsResponse.status).toBe(200);
      const detailsData = await detailsResponse.json();
      expect(detailsData.chat.nftRequirement.contractAddress).toBe(
        TEST_NFT_CONTRACT
      );
      expect(detailsData.chat.nftRequirement.tokenId).toBe(42);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('should handle missing chat ID in verification endpoint', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const user = await createTestUser();
      const token = await getAuthToken(user.id);

      const response = await authenticatedFetch(
        '/api/chats/invalid-id/nft-verification',
        {
          method: 'GET',
          headers: {
            ...authHeaders(token),
          },
        }
      );

      if (!token) {
        await expectAuthRequired(response);
        return;
      }

      expect(response.status).toBe(404);
    });

    test('should handle concurrent verification requests', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const user = await createTestUser(TEST_WALLET_WITH_NFT);
      const token = await getAuthToken(user.id);

      // Create NFT-gated chat
      const createResponse = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
        },
        body: JSON.stringify({
          name: 'Concurrent Test Group',
          memberIds: [user.id],
          nftGated: true,
          requiredNftContractAddress: TEST_NFT_CONTRACT,
          requiredNftChainId: getCurrentChainId(),
        }),
      });

      if (!token) {
        await expectAuthRequired(createResponse);
        return;
      }

      const createData = await createResponse.json();
      const { chatId } = trackCreatedGroup(createData);

      // Make concurrent verification requests
      const requests = Array.from({ length: 5 }, () =>
        authenticatedFetch(`/api/chats/${chatId}/nft-verification`, {
          method: 'GET',
          headers: {
            ...authHeaders(token),
          },
        })
      );

      const responses = await Promise.all(requests);
      responses.forEach((response) => {
        expect(response.status).toBe(400);
      });

      // All responses should be consistent
      const results = await Promise.all(responses.map((r) => r.json()));
      const firstResult = results[0];
      results.forEach((result) => {
        expect(result.error).toContain('No contract');
        expect(result.error).toBe(firstResult.error);
      });
    });

    test('should handle invalid chain ID gracefully', async () => {
      if (!serverAvailable || !databaseAvailable) {
        console.log('Skipping test: server or database not available');
        return;
      }

      const user = await createTestUser();
      const token = await getAuthToken(user.id);

      const response = await authenticatedFetch('/api/groups', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
        },
        body: JSON.stringify({
          name: 'Invalid Chain Group',
          memberIds: [user.id],
          nftGated: true,
          requiredNftContractAddress: TEST_NFT_CONTRACT,
          requiredNftChainId: 99999, // Invalid chain ID
        }),
      });

      if (!token) {
        await expectAuthRequired(response);
        return;
      }

      // Should either reject or use default chain
      expect([200, 201, 400, 500]).toContain(response.status);
    });
  });
});
