#!/usr/bin/env bun

import { AgentServer } from '@elizaos/server';
import { ElizaClient } from '@elizaos/api-client';
import { ChannelType } from '@elizaos/core';

async function testChannelCreationCorrect() {
    console.log('💬 Testing Channel Creation (Correct Parameters)...');

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

        // Step 4: Try to create a channel with the correct parameter names
        console.log('\n💬 Creating test channel...');
        try {
            // Based on server validation, we need participantCentralUserIds (not participantIds)
            const testUserId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

            // Use the raw HTTP client to send the correct parameter names
            const response = await fetch(`http://localhost:${port}/api/messaging/central-channels`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: 'test-channel-correct',
                    server_id: defaultServer.id,
                    participantCentralUserIds: [testUserId], // Correct parameter name
                    type: ChannelType.GROUP,
                    metadata: {
                        test: true,
                        scenario: 'channel-creation-test',
                    },
                }),
            });

            if (response.ok) {
                const result = await response.json();
                console.log('✅ Channel created successfully!');
                console.log('📊 Response:', JSON.stringify(result, null, 2));
            } else {
                const errorText = await response.text();
                console.error('❌ Channel creation failed with status:', response.status);
                console.error('❌ Error response:', errorText);
            }

        } catch (error) {
            console.error('❌ Channel creation failed:', error);
            console.error('Error details:', error instanceof Error ? error.message : String(error));
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
testChannelCreationCorrect().catch(console.error); 