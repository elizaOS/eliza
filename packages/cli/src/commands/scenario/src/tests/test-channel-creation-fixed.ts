#!/usr/bin/env bun

import { AgentServer } from '@elizaos/server';
import { ElizaClient } from '@elizaos/api-client';
// no-op

async function testChannelCreationFixed() {
    console.log('💬 Testing Channel Creation (Fixed)...');

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

        // Step 3: List existing servers to get serverId
        console.log('\n🏢 Listing servers...');
        const { servers } = await client.messaging.listServers();
        console.log(`📊 Found ${servers.length} servers:`);
        servers.forEach(s => console.log(`  - ${s.name} (${s.id})`));

        if (servers.length === 0) {
            throw new Error('No servers found');
        }

        const defaultServer = servers[0];
        console.log(`✅ Using server: ${defaultServer.name} (${defaultServer.id})`);

        // Step 4: Try to create a channel with the correct parameters
        console.log('\n💬 Creating test channel...');
        try {
            // Based on server validation, we need participantCentralUserIds
            // Let's create a test user ID for this
            const testUserId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

            const channel = await client.messaging.createGroupChannel({
                name: 'test-channel-fixed',
                participantIds: [testUserId],
                metadata: {
                    test: true,
                    scenario: 'channel-creation-test',
                },
            });

            console.log('✅ Channel created successfully!');
            console.log(`📊 Channel: ${channel.name} (${channel.id})`);
            console.log(`📊 Server ID: ${channel.messageServerId}`);
            console.log(`📊 Type: ${channel.type}`);

        } catch (error) {
            console.error('❌ Channel creation failed:', error);
            console.error('Error details:', error instanceof Error ? error.message : String(error));

            // Try to get more details about the error
            if (error instanceof Error && error.message) {
                console.error('Full error message:', error.message);
            }
        }

        console.log('\n🎉 Channel creation test completed!');

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
testChannelCreationFixed().catch(console.error); 