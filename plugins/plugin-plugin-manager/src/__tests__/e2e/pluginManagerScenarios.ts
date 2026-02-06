import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { strict as assert } from 'node:assert';
import { sendMessageAndWaitForResponse, setupScenario } from './test-utils.ts';

/**
 * Defines a suite of E2E tests for Plugin Manager real-world scenarios.
 *
 * These scenarios simulate authentic user interactions with the plugin management agent,
 * covering the complete user journey from plugin discovery to dynamic loading.
 */
export const pluginManagerScenariosSuite: TestSuite = {
  name: 'Plugin Manager Real-World Scenarios',
  tests: [
    {
      name: 'Scenario 1: User Discovers Plugin Capabilities',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // User asks about available plugins
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'What plugins are currently available?'
        );

        assert(response, 'Agent should respond to plugin status query');
        assert(
          response.text &&
            (response.text.includes('Loaded Plugins') ||
              response.text.includes('plugins') ||
              response.text.includes('available')),
          'Response should include plugin status information'
        );
      },
    },
    {
      name: 'Scenario 2: User Searches for Specific Plugin Functionality',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // User searches for weather-related plugins
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Can you search for plugins that handle weather data or weather APIs?'
        );

        assert(response, 'Agent should respond to plugin search');
        assert(
          response.text &&
            (response.text.includes('weather') ||
              response.text.includes('found') ||
              response.text.includes('plugin')),
          'Response should include search results'
        );
      },
    },
    {
      name: 'Scenario 3: User Clones a Plugin for Development',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // User wants to clone a plugin
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'I want to clone the bootstrap plugin to modify it for my needs'
        );

        assert(response, 'Agent should respond to clone request');
        assert(
          response.text &&
            (response.text.includes('clone') ||
              response.text.includes('bootstrap') ||
              response.text.includes('Successfully') ||
              response.text.includes('development')),
          'Response should indicate cloning action'
        );
      },
    },
    {
      name: 'Scenario 4: User Checks Plugin Dependencies Before Loading',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'What dependencies does the solana plugin require?'
        );

        assert(response, 'Agent should respond about dependencies');
        assert(
          response.text &&
            (response.text.includes('dependencies') ||
              response.text.includes('require') ||
              response.text.includes('solana')),
          'Response should mention dependencies'
        );
      },
    },
    {
      name: 'Scenario 5: User Attempts to Load Plugin with Missing Environment Variables',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Load the test-plugin-with-env plugin'
        );

        assert(response, 'Agent should respond to load attempt');
        // Should either load successfully or report missing env vars
        assert(
          response.text &&
            (response.text.includes('loaded') ||
              response.text.includes('environment') ||
              response.text.includes('missing') ||
              response.text.includes('variable')),
          'Response should indicate load result or missing requirements'
        );
      },
    },
    {
      name: 'Scenario 6: User Requests Plugin Version Information',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'What version of the bootstrap plugin is loaded?'
        );

        assert(response, 'Agent should respond about plugin version');
        assert(
          response.text &&
            (response.text.includes('version') ||
              response.text.includes('bootstrap') ||
              response.text.includes('loaded')),
          'Response should mention version information'
        );
      },
    },
    {
      name: 'Scenario 7: User Publishes a Plugin After Development',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'How do I publish my custom plugin to npm?'
        );

        assert(response, 'Agent should respond about publishing');
        assert(
          response.text &&
            (response.text.includes('publish') ||
              response.text.includes('npm') ||
              response.text.includes('registry')),
          'Response should mention publishing process'
        );
      },
    },
    {
      name: 'Scenario 8: User Handles Plugin Load Errors Gracefully',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Load the non-existent-plugin'
        );

        assert(response, 'Agent should respond to failed load attempt');
        assert(
          response.text &&
            (response.text.includes('error') ||
              response.text.includes('not found') ||
              response.text.includes('failed') ||
              response.text.includes('unable')),
          'Response should indicate the plugin cannot be loaded'
        );
      },
    },
    {
      name: 'Scenario 9: User Manages Plugin Configuration',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Configure the test plugin with API key'
        );

        assert(response, 'Agent should respond about configuration');
        assert(
          response.text &&
            (response.text.includes('configure') ||
              response.text.includes('config') ||
              response.text.includes('setting')),
          'Response should mention configuration'
        );
      },
    },
    {
      name: 'Scenario 10: User Discovers Plugin Registry',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Show me new plugins from the registry'
        );

        assert(response, 'Agent should respond about registry');
        assert(
          response.text &&
            (response.text.includes('plugin') ||
              response.text.includes('registry') ||
              response.text.includes('available')),
          'Response should mention plugin registry'
        );
      },
    },
    {
      name: 'Scenario 11: User Checks Plugin Memory Usage',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'How much memory are the loaded plugins using?'
        );

        assert(response, 'Agent should respond about memory usage');
        assert(
          response.text &&
            (response.text.toLowerCase().includes('memory') ||
              response.text.toLowerCase().includes('usage') ||
              response.text.toLowerCase().includes('loaded')),
          'Response should address memory concerns'
        );
      },
    },
    {
      name: 'Scenario 12: User Handles Circular Dependencies',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Load plugin-a which depends on plugin-b that depends on plugin-a'
        );

        assert(response, 'Agent should respond about circular dependency');
        assert(
          response.text &&
            (response.text.includes('depend') ||
              response.text.includes('circular') ||
              response.text.includes('cannot') ||
              response.text.includes('load')),
          'Response should handle circular dependency'
        );
      },
    },
    {
      name: 'Scenario 13: User Requests Plugin Rollback After Error',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // First load a plugin
        await sendMessageAndWaitForResponse(runtime, room, user, 'Load the test-plugin');

        // Then request rollback
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'The plugin is causing issues, can you rollback to the previous state?'
        );

        assert(response, 'Agent should respond about rollback');
        assert(
          response.text &&
            (response.text.includes('rollback') ||
              response.text.includes('unload') ||
              response.text.includes('restore') ||
              response.text.includes('previous')),
          'Response should address rollback request'
        );
      },
    },
    {
      name: 'Scenario 14: User Searches for Security-Approved Plugins',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Show me only security-audited or verified plugins'
        );

        assert(response, 'Agent should respond about security');
        assert(
          response.text &&
            (response.text.includes('security') ||
              response.text.includes('verified') ||
              response.text.includes('audit') ||
              response.text.includes('plugin')),
          'Response should address security concerns'
        );
      },
    },
    {
      name: 'Scenario 15: User Manages Plugin Permissions',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'What permissions does the file-manager plugin require?'
        );

        assert(response, 'Agent should respond about permissions');
        assert(
          response.text &&
            (response.text.includes('permission') ||
              response.text.includes('access') ||
              response.text.includes('require') ||
              response.text.includes('file')),
          'Response should discuss plugin permissions'
        );
      },
    },
  ],
};
