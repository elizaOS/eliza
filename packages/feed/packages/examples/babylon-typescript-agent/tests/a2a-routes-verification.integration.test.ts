/**
 * A2A Client Routes Verification Tests
 *
 * Tests the BabylonA2AClient wrapper against live server.
 * Verifies client connection, authentication, and the current wrapper surface.
 *
 * This tests the client wrapper, not the raw A2A protocol.
 */

import { describe, expect, it } from 'bun:test';
import {
  BabylonA2AClient,
  type BabylonA2AClientConfig,
} from '../src/a2a-client';

// Test with mock credentials for route verification
const TEST_CONFIG: BabylonA2AClientConfig = {
  baseUrl: 'http://localhost:3000',
  address: '0x' + '1'.repeat(40),
  tokenId: 999999,
  privateKey: '0x' + '1'.repeat(64),
  apiKey: process.env.BABYLON_API_KEY || 'test-api-key',
};

describe('A2A Routes Live Verification', () => {
  const client = new BabylonA2AClient(TEST_CONFIG);

  it('should connect to Babylon A2A HTTP endpoint', async () => {
    console.log('\n🔍 Testing A2A HTTP Connection...');

    // Check if server is accessible
    const response = await fetch('http://localhost:3000/api/health');
    const health = await response.json();
    expect(health.status).toBe('ok');
    console.log('✅ Server is running:', health.status);

    // Create and connect A2A client
    await client.connect();
    expect(client.agentId).toBeDefined();
    console.log('✅ A2A Client connected successfully');
  });

  it('should get balance', async () => {
    const balanceResult = await client.getBalance();
    console.log('   ✅ getBalance:', balanceResult);
    expect(balanceResult).toBeDefined();
  });

  it('should get positions', async () => {
    const positionsResult = await client.getPositions();
    console.log('   ✅ getPositions:', positionsResult);
    expect(positionsResult).toBeDefined();
  });

  it('should get predictions', async () => {
    const result = await client.getPredictions();
    console.log('   ✅ getPredictions:', result);
    expect(result).toBeDefined();
  });

  it('should get feed', async () => {
    const result = await client.getFeed();
    console.log('   ✅ getFeed:', result);
    expect(result).toBeDefined();
  });

  it('should get leaderboard', async () => {
    const result = await client.getLeaderboard({ limit: 5 });
    console.log('   ✅ getLeaderboard:', result);
    expect(result).toBeDefined();
  });
});

// Test that can run without connection
describe('A2A Client Method Availability', () => {
  it('should expose the current BabylonA2AClient methods used by this package', () => {
    const client = new BabylonA2AClient(TEST_CONFIG);

    const methods = [
      // Markets (2)
      'getPredictions',
      'getPerpetuals',
      // Portfolio (2)
      'getBalance',
      'getPositions',
      // Social and chats (3)
      'getFeed',
      'getChats',
      'getNotifications',
      // Discovery and stats (3)
      'searchUsers',
      'getLeaderboard',
      'getSystemStats',
    ];

    const missingMethods: string[] = [];

    methods.forEach((method) => {
      if (
        typeof (
          client as unknown as Record<string, (...args: unknown[]) => unknown>
        )[method] !== 'function'
      ) {
        missingMethods.push(method);
      }
    });

    if (missingMethods.length > 0) {
      console.log('❌ Missing methods:', missingMethods);
    } else {
      console.log(
        `✅ All ${methods.length} checked wrapper methods are available`
      );
    }

    expect(missingMethods.length).toBe(0);
    expect(methods.length).toBe(10);
  });
});

// Moderation operations tests
describe('A2A Moderation Operations', () => {
  const client = new BabylonA2AClient(TEST_CONFIG);

  it('should block a user via A2A', async () => {
    console.log('\n🚫 Testing block user...');

    await client.connect();

    const blockResult = await client.blockUser({
      userId: 'test-user-to-block',
      reason: 'Test block via A2A',
    });

    console.log('   ✅ blockUser executed:', blockResult);
    expect(blockResult).toBeDefined();
  });

  it('should unblock a user via A2A', async () => {
    console.log('\n✅ Testing unblock user...');

    const unblockResult = await client.unblockUser({
      userId: 'test-user-to-block',
    });

    console.log('   ✅ unblockUser executed:', unblockResult);
    expect(unblockResult).toBeDefined();
  });

  it('should mute a user via A2A', async () => {
    console.log('\n🔇 Testing mute user...');

    const muteResult = await client.muteUser({
      userId: 'test-user-to-mute',
      reason: 'Test mute via A2A',
    });

    console.log('   ✅ muteUser executed:', muteResult);
    expect(muteResult).toBeDefined();
  });

  it('should unmute a user via A2A', async () => {
    console.log('\n🔊 Testing unmute user...');

    const unmuteResult = await client.unmuteUser({
      userId: 'test-user-to-mute',
    });

    console.log('   ✅ unmuteUser executed:', unmuteResult);
    expect(unmuteResult).toBeDefined();
  });

  it('should report a user via A2A', async () => {
    console.log('\n🚩 Testing report user...');

    const reportResult = await client.reportUser({
      userId: 'test-user-to-report',
      category: 'spam',
      reason: 'Test report via A2A - automated testing',
      evidence: 'https://example.com/test-evidence.png',
    });

    console.log('   ✅ reportUser executed:', reportResult);
    expect(reportResult).toBeDefined();
  });

  it('should report a post via A2A', async () => {
    console.log('\n📝 Testing report post...');

    const reportResult = await client.reportPost({
      postId: 'test-post-to-report',
      category: 'misinformation',
      reason: 'Test report via A2A - automated testing',
    });

    console.log('   ✅ reportPost executed:', reportResult);
    expect(reportResult).toBeDefined();
  });

  it('should get blocked users list via A2A', async () => {
    console.log('\n📋 Testing get blocks...');

    const blocksResult = await client.getBlocks({
      limit: 10,
      offset: 0,
    });

    console.log('   ✅ getBlocks executed:', blocksResult);
    expect(blocksResult).toBeDefined();
  });

  it('should get muted users list via A2A', async () => {
    console.log('\n📋 Testing get mutes...');

    const mutesResult = await client.getMutes({
      limit: 10,
      offset: 0,
    });

    console.log('   ✅ getMutes executed:', mutesResult);
    expect(mutesResult).toBeDefined();
  });

  it('should check block status via A2A', async () => {
    console.log('\n🔍 Testing check block status...');

    const statusResult = await client.checkBlockStatus({
      userId: 'test-user-123',
    });

    console.log('   ✅ checkBlockStatus executed:', statusResult);
    expect(statusResult).toBeDefined();
  });

  it('should check mute status via A2A', async () => {
    console.log('\n🔍 Testing check mute status...');

    const statusResult = await client.checkMuteStatus({
      userId: 'test-user-123',
    });

    console.log('   ✅ checkMuteStatus executed:', statusResult);
    expect(statusResult).toBeDefined();
  });
});
