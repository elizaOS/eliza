/**
 * Quick Start Guide for ElizaOS
 * 
 * This example shows the simplest way to get started with ElizaOS
 */

import { ElizaOS, Character } from '@elizaos/core';

async function main() {
  // 1. Create an ElizaOS instance
  const elizaos = new ElizaOS({
    name: 'MyElizaOS',
    debug: true,
    serverConfig: {
      enabled: true,
      port: 3000,
    },
  });

  // 2. Initialize the system
  await elizaos.initialize();

  // 3. Create a simple character
  const character: Character = {
    name: 'Helper',
    bio: 'A helpful assistant',
    system: 'You are a helpful assistant that answers questions accurately and concisely.',
    messageExamples: [
      [
        { name: 'user', content: { text: 'What is TypeScript?' } },
        { name: 'Helper', content: { text: 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.' } }
      ]
    ],
    topics: ['programming', 'technology'],
    adjectives: ['helpful', 'accurate', 'concise'],
  };

  // 4. Create an agent with the character
  const agentId = await elizaos.createAgent({
    character,
    autoStart: true,
  });

  console.log(`Created agent: ${agentId}`);

  // 5. Get system status
  const status = elizaos.getSystemStatus();
  console.log('System Status:', {
    totalAgents: status.totalAgents,
    activeAgents: status.activeAgents,
    plugins: status.plugins.length,
  });

  // 6. Start the system (if server is enabled)
  await elizaos.start();
  
  console.log('ElizaOS is running on http://localhost:3000');
  console.log('Press Ctrl+C to stop');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await elizaos.stop();
    process.exit(0);
  });
}

// Run the example
main().catch(console.error);

