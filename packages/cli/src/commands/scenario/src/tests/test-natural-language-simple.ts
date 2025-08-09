#!/usr/bin/env bun

import { createScenarioServerAndAgent, askAgentViaApi } from '../runtime-factory';

async function testNaturalLanguage() {
    console.log('🧪 Testing Natural Language Agent Interaction...');

    let server: any | null = null;
    let agentId: any | null = null;

    try {
        // Spin up a minimal server + agent for NL interaction
        const created = await createScenarioServerAndAgent();
        server = created.server;
        agentId = created.agentId;

        // Ask the agent via the API
        const response = await askAgentViaApi(
            server,
            agentId,
            'Hello! Can you tell me what you can help me with?',
            30000
        );

        console.log('✅ Agent Response:', response);

        // Check if response contains expected keywords
        const lower = response.toLowerCase();
        const hasHelp = lower.includes('help');
        const hasAssist = lower.includes('assist');

        console.log(`📊 Analysis:`);
        console.log(`  - Contains "help": ${hasHelp}`);
        console.log(`  - Contains "assist": ${hasAssist}`);
        console.log(`  - Test ${hasHelp || hasAssist ? 'PASSED' : 'FAILED'}`);

    } catch (error) {
        console.error('❌ Test failed:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    } finally {
        if (server) {
            try {
                await server.stop();
                console.log('✅ Server stopped');
            } catch (e) {
                console.log('⚠️ Error stopping server:', e instanceof Error ? e.message : String(e));
            }
        }
    }
}

testNaturalLanguage().catch(console.error);