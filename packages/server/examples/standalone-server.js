#!/usr/bin/env node

/**
 * Example: Standalone Server Usage
 *
 * This example demonstrates how to use @elizaos/server as a standalone package
 * without relying on the CLI. It shows the basic usage pattern for creating
 * and running an agent server independently.
 */

import { AgentServer } from '../dist/index.js';

// Example character configuration
const exampleCharacter = {
  name: 'Assistant',
  username: 'assistant',
  system: 'You are a helpful AI assistant. Be concise and helpful in your responses.',
  bio: [
    'A friendly AI assistant designed to help users with various tasks.',
    'Knowledgeable across many domains and eager to help.',
  ],
  lore: [
    'Created to demonstrate the standalone server functionality.',
    'Represents the modular architecture of ElizaOS.',
  ],
  messageExamples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Hello! How can you help me today?',
        },
      },
      {
        user: 'Assistant',
        content: {
          text: "Hello! I'm here to help you with any questions or tasks you might have. Feel free to ask me anything!",
        },
      },
    ],
  ],
  postExamples: [],
  people: [],
  topics: ['general assistance', 'questions', 'help'],
  style: {
    all: [
      'be helpful and concise',
      'provide clear explanations',
      'ask clarifying questions when needed',
    ],
    chat: ['be conversational and friendly', 'use a warm, approachable tone'],
    post: ['be informative and engaging'],
  },
  adjectives: ['helpful', 'knowledgeable', 'friendly', 'reliable'],
};

async function main() {
  console.log('🚀 Starting ElizaOS Server independently...');

  try {
    // Create the agent server instance
    console.log('📦 Creating AgentServer instance...');
    const server = new AgentServer();

    // Initialize the server with optional configuration
    console.log('⚙️  Initializing server with database and services...');
    await server.initialize({
      dataDir: './data', // Optional custom data directory
      middlewares: [], // Optional custom middlewares
      // postgresUrl: process.env.DATABASE_URL // Optional PostgreSQL connection
    });

    console.log('✅ Server initialized successfully');

    // Note: In a real implementation, you would create an AgentRuntime
    // and register it with the server. For this example, we're showing
    // the server initialization process.

    console.log('🎯 Creating example agent runtime...');
    // const runtime = new AgentRuntime({
    //   character: exampleCharacter,
    //   database: server.database,
    //   // ... other runtime configuration
    // });

    // await server.registerAgent(runtime);
    console.log('📝 Note: Agent registration requires full AgentRuntime setup');

    // Start the server on specified port
    const port = process.env.PORT || 3000;
    console.log(`🌐 Starting server on port ${port}...`);

    server.start(port);

    console.log(`✨ Server is running at http://localhost:${port}`);
    console.log('🎭 Dashboard available at the root URL');
    console.log('🔌 API endpoints available at /api/*');
    console.log('📡 WebSocket available for real-time communication');

    // Graceful shutdown handling
    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down server gracefully...');
      await server.stop();
      process.exit(0);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Environment variable examples
console.log('📋 Environment Variables (optional):');
console.log('   PORT=3000                    # Server port');
console.log('   DATABASE_URL=postgres://...  # PostgreSQL connection');
console.log('   ELIZA_SERVER_AUTH_TOKEN=...  # API authentication');
console.log('   CORS_ORIGIN=*                # CORS configuration');
console.log('');

main().catch(console.error);
