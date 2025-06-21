export default {
  name: 'scenario-test-project',
  agents: [
    {
      name: 'test-agent',
      character: {
        name: 'Test Agent',
        clients: [],
        plugins: [
          '@elizaos/plugin-message-handling',
          '@elizaos/plugin-github', 
          '@elizaos/plugin-todo',
          '@elizaos/plugin-knowledge',
          '@elizaos/plugin-research',
        ],
        bio: [
          'A test agent for running scenarios',
        ],
        messageExamples: [],
        postExamples: [],
        topics: [],
        adjectives: [],
        knowledge: [],
        settings: {
          model: 'gpt-4',
          OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'test-key',
        },
      },
    },
  ],
}; 