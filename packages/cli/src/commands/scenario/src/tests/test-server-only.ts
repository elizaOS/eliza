#!/usr/bin/env bun

import { AgentServer } from '@elizaos/server';
import { startAgent, stopAgent } from '../../../start/actions/agent-start';

async function testServerOnly() {
    console.log('🧪 Testing Server and Agent Creation...');

    try {
        // Step 1: Create and start server
        console.log('📦 Creating AgentServer...');
        const server = new AgentServer();

        console.log('🔧 Initializing server...');
        await server.initialize({
            dataDir: './test-data',
        });

        // Set up the server methods
        server.startAgent = (character) => startAgent(character, server);
        server.stopAgent = (runtime) => stopAgent(runtime, server);

        console.log('🌐 Starting server on port 3000...');
        await server.start(3000);
        console.log('✅ Server started successfully');

        // Step 2: Create agent character
        console.log('🤖 Creating agent character...');
        const character = {
            name: 'test-agent',
            bio: 'A test agent',
            plugins: ['@elizaos/plugin-sql'], // Only SQL plugin
            settings: {
                secrets: {
                    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
                },
            },
            style: {
                all: ['be helpful', 'be concise'],
                chat: ['be conversational'],
            },
        };

        // Step 3: Start agent
        console.log('🚀 Starting agent...');
        const agentRuntime = await server.startAgent(character);
        console.log(`✅ Agent started: ${agentRuntime.character.name} (${agentRuntime.character.id})`);

        // Step 4: Clean up
        console.log('🛑 Stopping server...');
        await server.stop();
        console.log('✅ Server stopped');

        console.log('🎉 Test completed successfully!');

    } catch (error) {
        console.error('❌ Test failed:', error instanceof Error ? error.message : String(error));
        console.error('Stack:', error instanceof Error ? error.stack : 'No stack trace');
        process.exit(1);
    }
}

testServerOnly().catch(console.error); 