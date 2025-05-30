#!/usr/bin/env node

import { AgentServer } from '../index';
import { v4 as uuidv4 } from 'uuid';
import type { UUID, Plugin } from '@elizaos/core';
import type { Character } from '@elizaos/core';
import { startAgent } from '../../commands/start';
import sqlPlugin from '@elizaos/plugin-sql';

// Test character for agent
const testCharacter: Character = {
  id: uuidv4() as UUID,
  name: 'TestAgent',
  bio: ['A test agent for API route testing'],
  settings: {
    model: 'gpt-3.5-turbo',
    secrets: {},
  },
  plugins: [sqlPlugin.name],
};

// Simple HTTP test utility
class TestClient {
  private baseUrl: string;

  constructor(private port: number) {
    this.baseUrl = `http://localhost:${port}`;
  }

  async request(method: string, path: string, data?: any) {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (data && method !== 'GET') {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);
    const body = await response.json().catch(() => null);

    return {
      status: response.status,
      body,
    };
  }

  post(path: string, data?: any) {
    return this.request('POST', path, data);
  }

  get(path: string, query?: Record<string, any>) {
    const queryString = query ? '?' + new URLSearchParams(query).toString() : '';
    return this.request('GET', path + queryString);
  }

  delete(path: string) {
    return this.request('DELETE', path);
  }
}

async function runTests() {
  console.log('🚀 Starting API Route Tests...\n');

  let server: AgentServer;
  let testClient: TestClient;
  let testAgentId: UUID;
  let testServerId: UUID;
  let testChannelId: UUID;
  let testUserId: UUID = uuidv4() as UUID;

  try {
    // Initialize server
    console.log('📦 Initializing server...');
    server = new AgentServer();

    // Assign the startAgent function to the server
    server.startAgent = async (character) => {
      return startAgent(character, server, undefined, [sqlPlugin]);
    };

    await server.initialize({
      dataDir: './test-data',
    });

    // Start server on test port
    const testPort = 3457;
    await new Promise<void>((resolve) => {
      server.start(testPort);
      server.server.once('listening', () => {
        console.log(`✅ Server started on port ${testPort}\n`);
        resolve();
      });
    });

    // Create test client
    testClient = new TestClient(testPort);

    // Create and start test agent
    console.log('🤖 Creating test agent...');
    const agent = await server.database.ensureAgentExists(testCharacter);
    testAgentId = agent.id;
    await server.startAgent(agent);
    console.log(`✅ Test agent created with ID: ${testAgentId}\n`);

    // Test 1: Basic API endpoints
    console.log('📝 Test 1: Testing basic API endpoints...');

    const helloResponse = await testClient.get('/api/hello');
    console.log(`  GET /api/hello - Status: ${helloResponse.status}`);
    if (helloResponse.status !== 200) {
      throw new Error(`Hello endpoint failed: ${JSON.stringify(helloResponse.body)}`);
    }

    const statusResponse = await testClient.get('/api/status');
    console.log(`  GET /api/status - Status: ${statusResponse.status}`);
    if (statusResponse.status !== 200) {
      throw new Error(`Status endpoint failed: ${JSON.stringify(statusResponse.body)}`);
    }

    const pingResponse = await testClient.get('/api/ping');
    console.log(`  GET /api/ping - Status: ${pingResponse.status}`);
    if (pingResponse.status !== 200) {
      throw new Error(`Ping endpoint failed: ${JSON.stringify(pingResponse.body)}`);
    }
    console.log('✅ Basic API endpoints working\n');

    // Test 2: Messages API - Get Central Servers (should be empty initially)
    console.log('📝 Test 2: Testing Messages API - Central Servers...');

    const getServersResponse = await testClient.get('/api/messages/central-servers');
    console.log(`  GET /api/messages/central-servers - Status: ${getServersResponse.status}`);
    if (getServersResponse.status !== 200) {
      throw new Error(`Get central servers failed: ${JSON.stringify(getServersResponse.body)}`);
    }
    console.log(`  Found ${getServersResponse.body.data.servers.length} servers`);
    console.log('✅ Central servers endpoint working\n');

    // Test 3: Create Central Server
    console.log('📝 Test 3: Creating central server...');
    const createServerResponse = await testClient.post('/api/messages/servers', {
      name: 'Test Server',
      sourceType: 'test',
      sourceId: 'test-server-1',
      metadata: { test: true },
    });

    console.log(`  POST /api/messages/servers - Status: ${createServerResponse.status}`);
    if (createServerResponse.status !== 201) {
      throw new Error(`Failed to create server: ${JSON.stringify(createServerResponse.body)}`);
    }
    testServerId = createServerResponse.body.data.server.id;
    console.log(`✅ Central server created with ID: ${testServerId}\n`);

    // Test 4: Create Central Channel
    console.log('📝 Test 4: Creating central channel...');
    const createChannelResponse = await testClient.post('/api/messages/channels', {
      messageServerId: testServerId,
      name: 'Test Channel',
      type: 'group',
      metadata: { test: true },
    });

    console.log(`  POST /api/messages/channels - Status: ${createChannelResponse.status}`);
    if (createChannelResponse.status !== 201) {
      throw new Error(`Failed to create channel: ${JSON.stringify(createChannelResponse.body)}`);
    }
    testChannelId = createChannelResponse.body.data.channel.id;
    console.log(`✅ Central channel created with ID: ${testChannelId}\n`);

    // Test 5: Submit Message
    console.log('📝 Test 5: Submitting message to central store...');
    const submitMessageResponse = await testClient.post('/api/messages/submit', {
      channel_id: testChannelId,
      server_id: testServerId,
      author_id: testUserId,
      content: 'Hello from test user',
      source_type: 'test',
      metadata: {
        senderDisplayName: 'Test User',
      },
    });

    console.log(`  POST /api/messages/submit - Status: ${submitMessageResponse.status}`);
    if (submitMessageResponse.status !== 201) {
      throw new Error(`Failed to submit message: ${JSON.stringify(submitMessageResponse.body)}`);
    }
    const messageId = submitMessageResponse.body.data.id;
    console.log(`✅ Message submitted with ID: ${messageId}\n`);

    // Test 6: Get Messages for Channel
    console.log('📝 Test 6: Retrieving messages from channel...');
    const getMessagesResponse = await testClient.get(
      `/api/messages/central-channels/${testChannelId}/messages`
    );

    console.log(
      `  GET /api/messages/central-channels/${testChannelId}/messages - Status: ${getMessagesResponse.status}`
    );
    if (getMessagesResponse.status !== 200) {
      throw new Error(`Failed to retrieve messages: ${JSON.stringify(getMessagesResponse.body)}`);
    }
    console.log(`✅ Retrieved ${getMessagesResponse.body.data.messages.length} messages\n`);

    // Test 7: Get Channel Details
    console.log('📝 Test 7: Getting channel details...');
    const getChannelDetailsResponse = await testClient.get(
      `/api/messages/central-channels/${testChannelId}/details`
    );

    console.log(
      `  GET /api/messages/central-channels/${testChannelId}/details - Status: ${getChannelDetailsResponse.status}`
    );
    if (getChannelDetailsResponse.status !== 200) {
      throw new Error(
        `Failed to get channel details: ${JSON.stringify(getChannelDetailsResponse.body)}`
      );
    }
    console.log(`✅ Retrieved channel details for: ${getChannelDetailsResponse.body.data.name}\n`);

    // Test 8: Get Channel Participants
    console.log('📝 Test 8: Getting channel participants...');
    const getParticipantsResponse = await testClient.get(
      `/api/messages/central-channels/${testChannelId}/participants`
    );

    console.log(
      `  GET /api/messages/central-channels/${testChannelId}/participants - Status: ${getParticipantsResponse.status}`
    );
    if (getParticipantsResponse.status !== 200) {
      throw new Error(
        `Failed to get participants: ${JSON.stringify(getParticipantsResponse.body)}`
      );
    }
    console.log(`✅ Retrieved ${getParticipantsResponse.body.data.length} participants\n`);

    // Test 9: Delete Message
    console.log('📝 Test 9: Deleting message...');
    const deleteMessageResponse = await testClient.delete(
      `/api/messages/central-channels/${testChannelId}/messages/${messageId}`
    );

    console.log(
      `  DELETE /api/messages/central-channels/${testChannelId}/messages/${messageId} - Status: ${deleteMessageResponse.status}`
    );
    if (deleteMessageResponse.status !== 204) {
      throw new Error(`Failed to delete message: ${JSON.stringify(deleteMessageResponse.body)}`);
    }
    console.log(`✅ Message deleted successfully\n`);

    // Test 10: Agent Direct Message API
    console.log('📝 Test 10: Testing agent direct message API...');
    const agentMessageResponse = await testClient.post(`/api/agents/${testAgentId}/message`, {
      channelId: testChannelId,
      serverId: testServerId,
      entityId: testUserId,
      text: 'Direct message to agent',
      userName: 'Test User',
      source: 'test',
    });

    console.log(
      `  POST /api/agents/${testAgentId}/message - Status: ${agentMessageResponse.status}`
    );
    if (agentMessageResponse.status !== 202) {
      throw new Error(`Failed to send agent message: ${JSON.stringify(agentMessageResponse.body)}`);
    }
    console.log(`✅ Agent message accepted for processing\n`);

    // Test 11: Create DM Channel
    console.log('📝 Test 11: Creating DM channel...');
    const user1Id = uuidv4() as UUID;
    const user2Id = uuidv4() as UUID;

    const dmChannelResponse = await testClient.get('/api/messages/dm-channel', {
      currentUserId: user1Id,
      targetUserId: user2Id,
      dmServerId: testServerId,
    });

    console.log(`  GET /api/messages/dm-channel - Status: ${dmChannelResponse.status}`);
    if (dmChannelResponse.status !== 200) {
      throw new Error(`Failed to create DM channel: ${JSON.stringify(dmChannelResponse.body)}`);
    }
    console.log(`✅ DM channel created: ${dmChannelResponse.body.data.name}\n`);

    // Test 12: Create Group Channel with Participants
    console.log('📝 Test 12: Creating group channel with participants...');
    const groupChannelResponse = await testClient.post('/api/messages/central-channels', {
      name: 'Test Group Channel',
      participantCentralUserIds: [user1Id, user2Id, testUserId],
      type: 'group',
      server_id: testServerId,
      metadata: { test: true },
    });

    console.log(`  POST /api/messages/central-channels - Status: ${groupChannelResponse.status}`);
    if (groupChannelResponse.status !== 201) {
      throw new Error(
        `Failed to create group channel: ${JSON.stringify(groupChannelResponse.body)}`
      );
    }
    console.log(`✅ Group channel created: ${groupChannelResponse.body.data.name}\n`);

    // Summary
    console.log('📊 Test Summary:');
    console.log('  ✅ Basic API endpoints - PASSED');
    console.log('  ✅ Central servers endpoint - PASSED');
    console.log('  ✅ Create server - PASSED');
    console.log('  ✅ Create channel - PASSED');
    console.log('  ✅ Submit message - PASSED');
    console.log('  ✅ Get messages - PASSED');
    console.log('  ✅ Get channel details - PASSED');
    console.log('  ✅ Get participants - PASSED');
    console.log('  ✅ Delete message - PASSED');
    console.log('  ✅ Agent direct message - PASSED');
    console.log('  ✅ Create DM channel - PASSED');
    console.log('  ✅ Create group channel - PASSED');
    console.log('\n✅ All tests passed successfully! 🎉\n');
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  } finally {
    // Cleanup
    if (server) {
      console.log('🧹 Cleaning up...');
      await server.stop();
      console.log('✅ Server stopped\n');
    }
  }
}

// Run the tests
runTests().catch(console.error);
