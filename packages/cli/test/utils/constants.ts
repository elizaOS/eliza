import path from 'path';
import os from 'os';

// Create a unique test directory in the system temp folder
export const cliCommand = 'elizaos'; // Assumes elizaos is in PATH
export const testDir = path.join(
  os.tmpdir(),
  'elizaos-test-' + Date.now() + Math.floor(Math.random() * 1000)
);
export const agentName = 'test-agent';
export const agent1Name = 'test-agent1';
export const agent2Name = 'test-agent2';

export const commands = ['create', 'start', 'agent', 'plugin', 'env'];
export const invalidName = '!invalid@name';
export const characters = [
  {
    name: agent1Name,
    system: 'You are a test agent 1.',
    bio: ['A test agent for integration testing.'],
    plugins: [],
  },
  {
    name: agent2Name,
    system: 'You are a test agent 2.',
    bio: ['A test agent for integration testing.'],
    plugins: [],
  },
];

// Create minimal plugin
export const pluginContent = `
import { Plugin } from '@elizaos/core';
import { customAction } from './customAction';
export default {
  name: 'TestPlugin',
  description: 'Test plugin for action registration',
  actions: [customAction]
} as Plugin;
`;

export const characterContent = `
{
"name": "TestAgent",
"plugins": ["./test-plugin.ts"],
"system": "Test agent for action registration",
"secrets": {}
}
`;

export const actionContent = `
import { Action } from '@elizaos/core';
export const customAction: Action = {
  name: 'test-action',
  description: 'Test action for integration testing',
  validate: () => true,
  handler: async (runtime, message, state, options, callback) => {
    if (callback) {
      callback({ text: 'Action executed successfully' });
    }
    return true;
  }
};
`;

// Create provider plugin
export const providerContent = `
        import { Provider } from '@elizaos/core';
        export const customProvider: Provider = {
          name: 'test-provider',
          get: async () => { return {text : 'Provider Success'};}
        };
      `;
