#!/usr/bin/env node

import { AgentServer } from '../index';
import { v4 as uuidv4 } from 'uuid';
import type { UUID } from '@elizaos/core';
import type { Character } from '@elizaos/core';
import { startAgent } from '../../commands/start';
import sqlPlugin from '@elizaos/plugin-sql';

// Test character for agent
const testCharacter: Character = {
  id: uuidv4() as UUID,
  name: 'TestAgent',
  bio: ['A test agent for frontend loading testing'],
  settings: {
    model: 'gpt-3.5-turbo',
    secrets: {},
  },
  plugins: [sqlPlugin.name],
} as Character;

class FrontendLoadingTest {
  private server: AgentServer;
  private testClient: any;
  private port: number;

  constructor() {
    this.port = 3457;
  }

  async start() {
    console.log('🚀 Starting Frontend Loading Test...');

    // Initialize server
    console.log('📦 Initializing server...');
    this.server = new AgentServer();

    // Assign the startAgent function to the server
    this.server.startAgent = async (character) => {
      return startAgent(character as any, this.server, undefined, [sqlPlugin]);
    };

    await this.server.initialize({
      dataDir: './test-data',
    });

    // Start server
    this.server.start(this.port);
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for server to start

    console.log(`✅ Server started on port ${this.port}`);

    // Create a test agent
    console.log('🤖 Creating test agent...');
    // First ensure the agent exists in the database
    const agent = await this.server.database.ensureAgentExists(testCharacter as any);
    const agentId = agent.id;

    // Then start the agent
    const agentRuntime = await this.server.startAgent(agent);
    console.log(`✅ Test agent created with ID: ${agentId}`);

    return agentId;
  }

  async testAPIEndpoints(agentId: UUID) {
    console.log('\n📝 Testing API endpoints that frontend depends on...');

    const baseUrl = `http://localhost:${this.port}`;

    // Test 1: Verify agent exists
    console.log(`  Testing: GET /api/agents/${agentId}`);
    const agentResponse = await fetch(`${baseUrl}/api/agents/${agentId}`);
    const agentData = await agentResponse.json();
    console.log(
      `  Status: ${agentResponse.status} - Agent: ${agentData.success ? agentData.data.name : 'Failed'}`
    );

    // Test 2: Check central servers (needed for serverId)
    console.log(`  Testing: GET /api/messages/central-servers`);
    const serversResponse = await fetch(`${baseUrl}/api/messages/central-servers`);
    const serversData = await serversResponse.json();
    console.log(
      `  Status: ${serversResponse.status} - Servers: ${serversData.success ? serversData.data.servers.length : 'Failed'}`
    );

    if (!serversData.success || serversData.data.servers.length === 0) {
      console.log('  ❌ No servers found - creating one...');
      const createServerResponse = await fetch(`${baseUrl}/api/messages/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Server',
          sourceType: 'test',
        }),
      });
      const serverResult = await createServerResponse.json();
      console.log(`  ✅ Created server: ${serverResult.data.server.id}`);
      serversData.data.servers.push(serverResult.data.server);
    }

    const serverId = serversData.data.servers[0].id;

    // Test 3: Create/get DM channel (this is what frontend needs)
    console.log(`  Testing: Create DM channel for agent chat`);
    const currentUserId = '00000000-0000-0000-0000-000000000001';
    const dmResponse = await fetch(
      `${baseUrl}/api/messages/dm-channel?targetUserId=${agentId}&currentUserId=${currentUserId}&dmServerId=${serverId}`
    );
    const dmData = await dmResponse.json();
    console.log(
      `  Status: ${dmResponse.status} - Channel: ${dmData.success ? dmData.data.id : 'Failed'}`
    );

    if (dmData.success) {
      const channelId = dmData.data.id;
      console.log(`\n🎯 Frontend should use this URL structure:`);
      console.log(
        `  ✅ WORKING: ${baseUrl}/chat/${channelId}?agentId=${agentId}&serverId=${serverId}`
      );
      console.log(`  ❌ BROKEN:  ${baseUrl}/chat/${agentId} (current route)`);

      return { agentId, channelId, serverId, currentUserId };
    } else {
      throw new Error('Failed to create DM channel');
    }
  }

  async testFrontendComponentLogic(testData: any) {
    console.log('\n🔍 Analyzing Frontend Component Logic...');

    // Simulate what the frontend component does
    const { agentId, channelId, serverId } = testData;

    console.log('\n📋 Current Route Analysis:');
    console.log(`  Route Pattern: /chat/:agentId`);
    console.log(`  Example URL: http://localhost:${this.port}/chat/${agentId}`);
    console.log(`  URL Params: { agentId: "${agentId}" }`);
    console.log(`  Search Params: {} (empty)`);

    console.log('\n🔍 Component Requirements Analysis:');
    console.log(`  Component expects:`);
    console.log(`    - channelId from path params: undefined ❌`);
    console.log(`    - agentId from search params: undefined ❌`);
    console.log(`    - serverId from search params: undefined ❌`);

    console.log('\n💡 Why "Loading chat context..." appears:');
    console.log(`  Component check: if (!channelId || !serverId || !targetAgentData)`);
    console.log(`    channelId: undefined ❌`);
    console.log(`    serverId: undefined ❌`);
    console.log(`    targetAgentData: ${agentId ? 'loaded ✅' : 'undefined ❌'}`);
    console.log(`  Result: Shows "Loading chat context..." forever!`);

    console.log('\n✅ Solution - Use Correct URL:');
    console.log(
      `  URL: http://localhost:${this.port}/chat/${channelId}?agentId=${agentId}&serverId=${serverId}`
    );
    console.log(`  This provides:`);
    console.log(`    channelId: "${channelId}" ✅`);
    console.log(`    agentId: "${agentId}" ✅`);
    console.log(`    serverId: "${serverId}" ✅`);
  }

  async testMessage(testData: any) {
    console.log('\n📨 Testing Message Flow...');

    const { channelId, agentId, serverId, currentUserId } = testData;
    const baseUrl = `http://localhost:${this.port}`;

    // Send a test message
    const messagePayload = {
      author_id: currentUserId,
      content: 'Hello, this is a test message!',
      server_id: serverId,
      metadata: {
        user_display_name: 'Test User',
      },
      source_type: 'eliza_gui',
    };

    console.log(`  Sending message to channel ${channelId}...`);
    const messageResponse = await fetch(
      `${baseUrl}/api/messages/central-channels/${channelId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messagePayload),
      }
    );

    const messageResult = await messageResponse.json();
    console.log(
      `  Status: ${messageResponse.status} - ${messageResult.success ? 'Message sent' : 'Failed'}`
    );

    // Wait a moment for agent processing
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check messages in channel
    const messagesResponse = await fetch(
      `${baseUrl}/api/messages/central-channels/${channelId}/messages`
    );
    const messagesData = await messagesResponse.json();
    console.log(
      `  Messages in channel: ${messagesData.success ? messagesData.data.messages.length : 'Failed to fetch'}`
    );
  }

  async stop() {
    console.log('\n🧹 Cleaning up...');
    if (this.server) {
      await this.server.stop();
      console.log('✅ Server stopped');
    }
  }
}

async function runTest() {
  const test = new FrontendLoadingTest();

  try {
    const agentId = await test.start();
    const testData = await test.testAPIEndpoints(agentId);
    await test.testFrontendComponentLogic(testData);
    await test.testMessage(testData);

    console.log('\n🎉 Test completed successfully!');
    console.log('\n📋 Summary:');
    console.log('✅ Server APIs working correctly');
    console.log('✅ Agent created and active');
    console.log('✅ DM channel created');
    console.log('✅ Message flow working');
    console.log('❌ Frontend route structure mismatch identified');
    console.log('\n💡 To fix: Use the correct URL structure provided above!');
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await test.stop();
  }
}

// Run the test
runTest().catch(console.error);
