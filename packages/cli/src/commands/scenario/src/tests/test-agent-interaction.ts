#!/usr/bin/env bun

import { AgentServer } from '@elizaos/server';
import { ElizaClient } from '@elizaos/api-client';
import { ChannelType, UUID } from '@elizaos/core';
import { startAgent, stopAgent } from '../../../start/actions/agent-start';

async function testAgentInteraction() {
    console.log('🤖 Testing Agent Creation and Interaction...');

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
            // These are already set up in the AgentServer constructor
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

        // Step 3: Create an agent with proper character configuration
        console.log('\n🤖 Creating test agent...');
        const agent = await client.agents.createAgent({
            characterJson: {
                name: 'Test Agent',
                bio: 'A helpful test agent that can assist with various tasks',
                plugins: ['@elizaos/plugin-bootstrap', '@elizaos/plugin-sql'],
                settings: {
                    secrets: {
                        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
                    },
                },
                style: {
                    all: ['be helpful', 'be concise'],
                    chat: ['be conversational'],
                },
            },
        });

        console.log('✅ Agent created:', agent.name, `(${agent.id})`);

        // Step 4: Start the agent
        console.log('\n🚀 Starting agent...');
        await client.agents.startAgent(agent.id);
        console.log('✅ Agent started successfully');

        // Step 5: Create a test channel
        console.log('\n💬 Creating test channel...');
        // Ensure we target the default server and set participants
        const { servers } = await client.messaging.listServers();
        if (!servers.length) throw new Error('No servers found');
        const defaultServer = servers[0];
        const testUserId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`) as UUID;
        const channelResp = await fetch(`http://localhost:${port}/api/messaging/central-channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'test-channel',
                server_id: defaultServer.id,
                participantCentralUserIds: [testUserId],
                type: ChannelType.GROUP,
                metadata: { test: true, scenario: 'api-test' }
            })
        });
        if (!channelResp.ok) throw new Error(`Channel creation failed: HTTP ${channelResp.status}`);
        const channelJson = await channelResp.json();
        const channel = channelJson.data;
        console.log('✅ Channel created:', channel.name, `(${channel.id})`);

        // Step 6: Add agent to channel
        console.log('\n➕ Adding agent to channel...');
        await client.messaging.addAgentToChannel(channel.id as UUID, agent.id as UUID);
        console.log('✅ Agent added to channel');

        // Step 7: Send a message to the agent
        console.log('\n💭 Sending message to agent...');
        const message = await client.messaging.postMessage(
            channel.id,
            'Hello! Can you tell me what you can help me with?',
            {
                test: true,
                scenario: 'api-test',
            }
        );

        console.log('✅ Message sent:', message.id);
        console.log('📝 Message content:', message.content);

        // Step 8: Wait for agent response
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

        // Step 9: List agents to confirm
        console.log('\n📋 Listing agents...');
        const { agents } = await client.agents.listAgents();
        console.log(`📊 Found ${agents.length} agents:`);
        agents.forEach(a => {
            console.log(`  - ${a.name} (${a.id})`);
        });

        console.log('\n🎉 Agent interaction test completed successfully!');

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
testAgentInteraction().catch(console.error); 