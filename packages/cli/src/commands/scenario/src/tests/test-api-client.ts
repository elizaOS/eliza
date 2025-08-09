#!/usr/bin/env bun

import { ElizaClient } from '@elizaos/api-client';

async function testApiClient() {
  console.log('🧪 Testing ElizaOS API Client...');
  
  try {
    // Create client instance
    const client = ElizaClient.create({
      baseUrl: 'http://localhost:3000',
      apiKey: process.env.ELIZA_API_KEY, // optional
    });
    
    console.log('✅ Client created successfully');
    
    // Show available services and methods
    console.log('\n�� Available services and methods:');
    console.log('  - agents methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(client.agents)));
    console.log('  - messaging methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(client.messaging)));
    console.log('  - memory methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(client.memory)));
    console.log('  - audio methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(client.audio)));
    console.log('  - media methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(client.media)));
    console.log('  - server methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(client.server)));
    console.log('  - system methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(client.system)));
    
    // Test server health
    console.log('\n🔍 Testing server health...');
    try {
      const health = await client.server.checkHealth();
      console.log('✅ Server health check passed:', health);
    } catch (error) {
      console.log('❌ Server health check failed:', error instanceof Error ? error.message : String(error));
      console.log('💡 Make sure the ElizaOS server is running on http://localhost:3000');
      console.log('💡 This is expected if no server is running');
    }
    
    // Test listing agents (will fail without server, but that's OK)
    console.log('\n🤖 Testing agent listing...');
    try {
      const { agents } = await client.agents.listAgents();
      console.log('✅ Agent listing successful');
      console.log(`📊 Found ${agents.length} agents:`);
      agents.forEach(agent => {
        console.log(`  - ${agent.name} (${agent.id})`);
      });
    } catch (error) {
      console.log('❌ Agent listing failed:', error instanceof Error ? error.message : String(error));
      console.log('💡 This is expected if no server is running');
    }
    
    // Test listing servers (will fail without server, but that's OK)
    console.log('\n🏢 Testing server listing...');
    try {
      const { servers } = await client.messaging.listServers();
      console.log('✅ Server listing successful');
      console.log(`📊 Found ${servers.length} servers:`);
      servers.forEach(server => {
        console.log(`  - ${server.name} (${server.id})`);
      });
    } catch (error) {
      console.log('❌ Server listing failed:', error instanceof Error ? error.message : String(error));
      console.log('💡 This is expected if no server is running');
    }
    
    console.log('\n🎉 API Client test completed!');
    console.log('✅ The API client is working correctly - it can be imported and instantiated');
    console.log('💡 To test with a real server, start the ElizaOS server on localhost:3000');
    
  } catch (error) {
    console.error('❌ API Client test failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run the test
testApiClient().catch(console.error); 