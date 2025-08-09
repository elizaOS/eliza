#!/usr/bin/env bun

import { AgentServer } from '@elizaos/server';
import { ElizaClient } from '@elizaos/api-client';
import { ChannelType, UUID } from '@elizaos/core';
import { startAgent, stopAgent } from '../../../start/actions/agent-start';

async function testFullMessagingFlow() {
    console.log('💬 Testing Full Messaging Flow...');

    let server: AgentServer | null = null;

    try {
        // Step 1: Start the server
        console.log('\n📦 Creating AgentServer...');
        server = new AgentServer();

        console.log('🔧 Initializing server...');
        await server.initialize({
            dataDir: './test-data',
        });

        // Set up the server methods like the CLI does
        if (server) {
            server.startAgent = (character) => startAgent(character, server!);
            server.stopAgent = (runtime) => stopAgent(runtime, server!);
        }

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

        // Step 4: Create an agent
        console.log('\n🤖 Creating test agent...');
        const agent = await client.agents.createAgent({
            characterJson: {
                name: 'Messaging Test Agent',
                bio: 'A test agent for messaging flow testing',
                plugins: ['@elizaos/plugin-bootstrap', '@elizaos/plugin-sql'],
                settings: {
                    secrets: {
                        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
                        GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
                        E2B_API_KEY: process.env.E2B_API_KEY || '',
                        POLYGONSCAN_KEY: process.env.POLYGONSCAN_KEY || '',
                        ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY || '',
                        WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || '',
                    },
                },
                style: {
                    all: ['be helpful', 'be concise'],
                    chat: ['be conversational'],
                },
            },
        });

        console.log('✅ Agent created:', agent.name, `(${agent.id})`);

        // Step 5: Start the agent
        console.log('\n🚀 Starting agent...');
        await client.agents.startAgent(agent.id);
        console.log('✅ Agent started successfully');

        // Step 6: Create a channel with correct parameters
        console.log('\n💬 Creating test channel...');
        const testUserId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`) as UUID;

        // Use raw HTTP to send correct parameters
        const channelResponse = await fetch(`http://localhost:${port}/api/messaging/central-channels`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: 'test-messaging-channel',
                server_id: defaultServer.id,
                participantCentralUserIds: [testUserId], // Correct parameter name
                type: ChannelType.GROUP,
                metadata: {
                    test: true,
                    scenario: 'messaging-test',
                },
            }),
        });

        if (!channelResponse.ok) {
            const errorText = await channelResponse.text();
            throw new Error(`Channel creation failed: ${channelResponse.status} - ${errorText}`);
        }

        const channelResult = await channelResponse.json();
        const channel = channelResult.data;
        console.log('✅ Channel created:', channel.name, `(${channel.id})`);

        // Step 7: Add agent to channel
        console.log('\n➕ Adding agent to channel...');
        await client.messaging.addAgentToChannel(channel.id as UUID, agent.id as UUID);
        console.log('✅ Agent added to channel');

        // Step 8: Send a message to the agent
        console.log('\n💭 Sending message to agent...');
        const message = await client.messaging.postMessage(
            channel.id,
            'Hello! Can you tell me what you can help me with?',
            {
                test: true,
                scenario: 'messaging-test',
            }
        );

        console.log('✅ Message sent:', message.id);
        console.log('📝 Message content:', message.content);

        // Step 9: Wait for agent response
        console.log('\n⏳ Waiting for agent response...');
        const agentResponse = await waitForAgentResponse(client, channel.id, agent.id, 30000);

        if (agentResponse) {
            console.log('✅ Agent responded!');
            console.log('📝 Response:', agentResponse.content);
            console.log('🔍 Raw message:', agentResponse.rawMessage);
            console.log('📊 Metadata:', agentResponse.metadata);
        } else {
            console.log('❌ No agent response received');
        }

        // Step 10: List messages in channel
        console.log('\n📋 Listing messages in channel...');
        const messages = await client.messaging.getChannelMessages(channel.id, {
            limit: 10,
        });
        console.log(`📊 Found ${messages.messages.length} messages in channel:`);
        messages.messages.forEach(msg => {
            console.log(`  - ${msg.authorId}: ${msg.content}`);
        });

        console.log('\n🎉 Full messaging flow test completed successfully!');

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

/**
 * Wait for agent response by polling for new messages
 */
async function waitForAgentResponse(
    client: ElizaClient,
    channelId: UUID,
    agentId: string,
    timeoutMs: number
): Promise<any> {
    const startTime = Date.now();
    const pollInterval = 1000; // 1 second

    while (Date.now() - startTime < timeoutMs) {
        try {
            // Get messages from the channel
            const messages = await client.messaging.getChannelMessages(channelId, {
                limit: 10,
            });

            // Look for agent response (messages from agent, not from us)
            const agentMessage = messages.messages.find(msg =>
                msg.authorId === agentId &&
                new Date(msg.createdAt).getTime() > Date.now() - 10000 // Within last 10 seconds
            );

            if (agentMessage) {
                console.log('✅ Found agent response:', agentMessage.id);
                return agentMessage;
            }

            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, pollInterval));

        } catch (error) {
            console.log('⚠️ Poll error:', error instanceof Error ? error.message : String(error));
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
    }

    console.log('⏰ Timeout waiting for agent response');
    return null;
}

// Run the test
testFullMessagingFlow().catch(console.error); 