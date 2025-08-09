#!/usr/bin/env bun

import { AgentServer } from '@elizaos/server';
import { ElizaClient } from '@elizaos/api-client';

async function testServerAndApi() {
    console.log('🚀 Starting ElizaOS Server and testing API Client...');

    let server: AgentServer | null = null;

    try {
        // Step 1: Create and initialize the server
        console.log('\n📦 Creating AgentServer...');
        server = new AgentServer();

        console.log('🔧 Initializing server...');
        await server.initialize({
            dataDir: './test-data',
        });

        console.log('✅ Server initialized successfully');

        // Step 2: Start the server
        const port = 3000;
        console.log(`🌐 Starting server on port ${port}...`);
        await server.start(port);

        console.log(`✅ Server started successfully at http://localhost:${port}`);

        // Step 3: Test the API client
        console.log('\n🧪 Testing API Client...');

        const client = ElizaClient.create({
            baseUrl: `http://localhost:${port}`,
        });

        console.log('✅ API Client created successfully');

        // Test server health
        console.log('\n🔍 Testing server health...');
        try {
            const health = await client.server.checkHealth();
            console.log('✅ Server health check passed:', health);
        } catch (error) {
            console.log('❌ Server health check failed:', error instanceof Error ? error.message : String(error));
        }

        // Test listing agents (should be empty initially)
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
        }

        // Test listing servers
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
        }

        console.log('\n🎉 All tests completed successfully!');
        console.log('✅ Server is running and API client is working');

        // Keep the server running for a bit so we can see the results
        console.log('\n⏰ Keeping server running for 10 seconds...');
        await new Promise(resolve => setTimeout(resolve, 10000));

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
testServerAndApi().catch(console.error); 