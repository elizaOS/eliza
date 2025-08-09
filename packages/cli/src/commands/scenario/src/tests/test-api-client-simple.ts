#!/usr/bin/env bun

import { AgentServer } from '@elizaos/server';
import { ElizaClient } from '@elizaos/api-client';
import { ChannelType } from '@elizaos/core';

async function testApiClientSimple() {
  console.log('🧪 Testing API Client (Simple)...');

  let server: AgentServer | null = null;

  try {
    // Step 1: Start the server
    console.log('\n📦 Creating AgentServer...');
    server = new AgentServer();

    console.log('🔧 Initializing server...');
    await server.initialize({
      dataDir: './test-data',
    });

    const port = 3000;
    console.log(`🌐 Starting server on port ${port}...`);
    await server.start(port);

    console.log(`✅ Server started successfully at http://localhost:${port}`);

    // Step 2: Create API client
    const client = ElizaClient.create({
      baseUrl: `http://localhost:${port}`,
    });

    console.log('✅ API Client created successfully');

    // Step 3: Test basic API endpoints
    console.log('\n🔍 Testing basic API endpoints...');

    // Test server health
    try {
      const health = await client.server.checkHealth();
      console.log('✅ Server health check passed:', health);
    } catch (error) {
      console.log('❌ Server health check failed:', error instanceof Error ? error.message : String(error));
    }

    // Test listing agents (should be empty initially)
    try {
      const { agents } = await client.agents.listAgents();
      console.log('✅ Agent listing successful');
      console.log(`📊 Found ${agents.length} agents`);
    } catch (error) {
      console.log('❌ Agent listing failed:', error instanceof Error ? error.message : String(error));
    }

    // Test listing servers
    try {
      const { servers } = await client.messaging.listServers();
      console.log('✅ Server listing successful');
      console.log(`📊 Found ${servers.length} servers`);
    } catch (error) {
      console.log('❌ Server listing failed:', error instanceof Error ? error.message : String(error));
    }

    // Test creating a channel (explicit server_id and participants)
    try {
      const { servers } = await client.messaging.listServers();
      if (!servers.length) throw new Error('No servers found');
      const defaultServer = servers[0];
      const testUserId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
      const port = 3000;
      const resp = await fetch(`http://localhost:${port}/api/messaging/central-channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test-channel',
          server_id: defaultServer.id,
          participantCentralUserIds: [testUserId],
          type: ChannelType.GROUP,
          metadata: { test: true },
        })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      const data = await resp.json();
      console.log('✅ Channel creation successful');
      console.log(`📊 Created channel: ${data?.data?.name} (${data?.data?.id})`);
    } catch (error) {
      console.log('❌ Channel creation failed:', error instanceof Error ? error.message : String(error));
    }

    console.log('\n🎉 API Client test completed successfully!');
    console.log('✅ Server is running and API client is working');

    // Keep running for a bit
    console.log('\n⏰ Keeping server running for 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    await server.stop();
    console.log('✅ Server stopped successfully');
    return;
  } catch (error) {
    console.error('❌ Test failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    // Clean up
    if (server) {
      console.log('\n🛑 Stopping server...');
      try {
        await server.stop();
        console.log('✅ Server stopped successfully');
      } catch (error) {
        console.log('⚠️ Error stopping server:', error instanceof Error ? error.message : String(error));
      }
    }
  }
}

// Run the test
testApiClientSimple().catch(console.error); 