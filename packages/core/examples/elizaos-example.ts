/**
 * Example usage of the ElizaOS global orchestrator
 * 
 * This example demonstrates how to:
 * - Initialize ElizaOS
 * - Create and manage multiple agents
 * - Use global plugins and services
 * - Monitor system status
 * - Handle events
 */

import { 
  ElizaOS, 
  Character, 
  Plugin,
  ElizaOSEventType,
  logger 
} from '@elizaos/core';

// Example character configuration
const exampleCharacter1: Character = {
  name: 'Assistant Alpha',
  bio: 'A helpful AI assistant focused on technical support',
  system: 'You are a technical support specialist.',
  messageExamples: [
    [
      { name: 'user', content: { text: 'How do I install a plugin?' } },
      { name: 'Assistant Alpha', content: { text: 'To install a plugin, use the command: npm install plugin-name' } }
    ]
  ],
  topics: ['technical support', 'programming', 'troubleshooting'],
  adjectives: ['helpful', 'knowledgeable', 'patient'],
  style: {
    all: ['Be clear and concise', 'Use technical terminology appropriately'],
    chat: ['Provide step-by-step instructions when needed'],
  }
};

const exampleCharacter2: Character = {
  name: 'Assistant Beta',
  bio: 'A creative AI assistant focused on content creation',
  system: 'You are a creative content assistant.',
  messageExamples: [
    [
      { name: 'user', content: { text: 'Help me write a blog post' } },
      { name: 'Assistant Beta', content: { text: "I'd be happy to help! Let's start by brainstorming topics and creating an outline." } }
    ]
  ],
  topics: ['writing', 'creativity', 'content creation'],
  adjectives: ['creative', 'inspiring', 'thoughtful'],
  style: {
    all: ['Be creative and engaging', 'Use vivid language'],
    chat: ['Encourage creativity and exploration'],
  }
};

// Example global plugin
const loggingPlugin: Plugin = {
  name: 'logging-plugin',
  description: 'Logs all agent activities',
  init: async (config, runtime) => {
    logger.info('Logging plugin initialized');
  },
  actions: [],
  providers: [],
  evaluators: [],
};

// Main example function
async function main() {
  try {
    // 1. Create ElizaOS instance with configuration
    const elizaos = new ElizaOS({
      name: 'MyElizaOS',
      debug: true,
      maxAgents: 10,
      globalPlugins: [loggingPlugin],
      serverConfig: {
        enabled: true,
        port: 3000,
        host: 'localhost',
        cors: true,
      },
      defaultSettings: {
        LOG_LEVEL: 'debug',
        ENVIRONMENT: 'development',
      },
    });

    // 2. Set up event listeners
    elizaos.on(ElizaOSEventType.SYSTEM_STARTED, (event) => {
      console.log('System started:', event.data);
    });

    elizaos.on(ElizaOSEventType.AGENT_CREATED, (event) => {
      console.log('Agent created:', event.data);
    });

    elizaos.on(ElizaOSEventType.AGENT_STARTED, (event) => {
      console.log('Agent started:', event.data);
    });

    elizaos.on(ElizaOSEventType.AGENT_ERROR, (event) => {
      console.error('Agent error:', event.data);
    });

    // 3. Initialize ElizaOS
    console.log('Initializing ElizaOS...');
    await elizaos.initialize();

    // 4. Start ElizaOS
    console.log('Starting ElizaOS...');
    await elizaos.start();

    // 5. Create first agent
    console.log('Creating first agent...');
    const agent1Id = await elizaos.createAgent({
      character: exampleCharacter1,
      autoStart: true,
      settings: {
        RESPONSE_TIMEOUT: '30000',
      },
    });

    // 6. Create second agent
    console.log('Creating second agent...');
    const agent2Id = await elizaos.createAgent({
      character: exampleCharacter2,
      autoStart: true,
      settings: {
        RESPONSE_TIMEOUT: '45000',
      },
    });

    // 7. Get system status
    const status = elizaos.getSystemStatus();
    console.log('System Status:', {
      uptime: status.uptime,
      activeAgents: status.activeAgents,
      totalAgents: status.totalAgents,
      memoryUsage: status.memoryUsage,
    });

    // 8. Get all agents
    const allAgents = elizaos.getAllAgents();
    console.log('All agents:', allAgents.map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
    })));

    // 9. Execute something with a specific agent's context
    await elizaos.withAgent(agent1Id, async (runtime) => {
      console.log('Executing with agent 1 context');
      // Use the agent's runtime to perform operations
      const agentName = runtime.character.name;
      console.log(`Working with agent: ${agentName}`);
      
      // Example: Get agent's memories (if any)
      const memories = await runtime.getAllMemories();
      console.log(`Agent has ${memories.length} memories`);
    });

    // 10. Broadcast a message to all agents
    console.log('Broadcasting message to all agents...');
    await elizaos.broadcast({
      type: 'system',
      content: 'System maintenance in 5 minutes',
    });

    // 11. Health check
    const isHealthy = await elizaos.healthCheck();
    console.log('System health:', isHealthy ? 'OK' : 'DEGRADED');

    // 12. Stop a specific agent
    console.log('Stopping agent 2...');
    await elizaos.stopAgent(agent2Id);

    // 13. Remove an agent
    console.log('Removing agent 2...');
    await elizaos.removeAgent(agent2Id);

    // 14. Register a new global plugin at runtime
    const runtimePlugin: Plugin = {
      name: 'runtime-plugin',
      description: 'Plugin added at runtime',
      actions: [],
      providers: [],
    };
    await elizaos.registerGlobalPlugin(runtimePlugin);

    // 15. Get agents by status
    const runningAgents = elizaos.getAgentsByStatus('running');
    console.log('Running agents:', runningAgents.length);

    // Wait for some time to simulate runtime
    console.log('System running... Press Ctrl+C to stop');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 16. Gracefully shutdown
    console.log('Stopping ElizaOS...');
    await elizaos.stop();

    // 17. Optional: Reset system (clears all state)
    console.log('Resetting ElizaOS...');
    await elizaos.reset();

    console.log('Example completed successfully!');
  } catch (error) {
    console.error('Error in example:', error);
    process.exit(1);
  }
}

// Run the example
if (require.main === module) {
  main().catch(console.error);
}

export { main };

