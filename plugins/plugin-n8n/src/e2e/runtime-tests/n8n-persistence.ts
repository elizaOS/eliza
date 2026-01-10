/**
 * N8n Persistence and Cache Management Tests
 */

import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { strict as assert } from 'node:assert';
import {
  setupScenario,
  sendMessageAndWaitForResponse,
  validateWorkflowResult,
  provideCredentials,
} from './test-utils';

export const n8nPersistenceSuite: TestSuite = {
  name: 'N8n Persistence Tests',
  tests: [
    {
      name: 'Test 1: Weather Data Caching (5 min TTL)',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Weather Data Caching Test ===');

        // First request - should fetch fresh data
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "What's the weather in London? Cache it for 5 minutes.",
          60000
        );

        console.log('First request:', response1.text);

        // Provide credentials if needed
        if (response1.text?.includes('OPENWEATHER_API_KEY')) {
          const credResponse = await provideCredentials(runtime, room, user, {
            OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY || '',
          });
          console.log('After credentials:', credResponse.text);
        }

        // Verify fresh data fetch
        assert.match(
          response1.text || '',
          /fetch|retriev|getting.*fresh|api.*call/i,
          'First request should fetch fresh data'
        );

        // Second request - should use cache
        const response2 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "What's the weather in London again?",
          30000
        );

        console.log('Second request (cached):', response2.text);

        // Verify cached response
        assert.match(
          response2.text || '',
          /cache|stored|already.*have|recent|same.*data/i,
          'Second request should use cached data'
        );

        console.log('✓ Weather caching test passed');
      },
    },

    {
      name: 'Test 2: Stock Data Caching (1 min TTL)',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Stock Data Caching Test ===');

        // First request
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Get AAPL stock price with 1 minute cache',
          60000
        );

        console.log('First stock request:', response1.text);

        // Provide credentials if needed
        if (response1.text?.includes('ALPHA_VANTAGE_API_KEY')) {
          const credResponse = await provideCredentials(runtime, room, user, {
            ALPHA_VANTAGE_API_KEY: process.env.ALPHA_VANTAGE_API_KEY || '',
          });
          console.log('After credentials:', credResponse.text);
        }

        // Extract price if available
        const priceMatch = response1.text?.match(/\$?\d+\.?\d*/);
        const firstPrice = priceMatch?.[0];

        // Immediate second request
        const response2 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Check AAPL price again',
          30000
        );

        console.log('Second request (should be cached):', response2.text);

        // Verify same price (cached)
        if (firstPrice) {
          assert(response2.text?.includes(firstPrice), 'Cached response should have same price');
        }

        assert.match(response2.text || '', /cache|stored|recent/i, 'Should indicate cached data');

        console.log('✓ Stock caching test passed');
      },
    },

    {
      name: 'Test 3: Workflow State Persistence',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Workflow State Persistence Test ===');

        // Create a stateful workflow
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Create a counter workflow that increments a value each time it runs. Start at 0.',
          60000
        );

        console.log('Workflow creation:', response1.text);

        // Run the workflow multiple times
        const runs = ['Run the counter', 'Run it again', 'One more time'];
        let lastCount = 0;

        for (const command of runs) {
          const response = await sendMessageAndWaitForResponse(runtime, room, user, command, 30000);

          console.log(`${command}:`, response.text);

          // Extract counter value
          const countMatch = response.text?.match(/count.*?(\d+)|value.*?(\d+)|(\d+)/i);
          if (countMatch) {
            const currentCount = parseInt(countMatch[1] || countMatch[2] || countMatch[3]);
            assert(
              currentCount > lastCount,
              `Counter should increment (was ${lastCount}, now ${currentCount})`
            );
            lastCount = currentCount;
          }
        }

        console.log('✓ Workflow state persistence test passed');
      },
    },

    {
      name: 'Test 4: Concurrent Execution Tracking',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Concurrent Execution Test ===');

        // Start multiple workflows
        const workflows = [
          'Start a workflow that waits 5 seconds then says "First"',
          'Start another workflow that waits 3 seconds then says "Second"',
          'Start a third workflow that immediately says "Third"',
        ];

        const promises = workflows.map((command) =>
          sendMessageAndWaitForResponse(runtime, room, user, command, 90000)
        );

        const responses = await Promise.all(promises);

        console.log('All workflows started');
        responses.forEach((r, i) => console.log(`Workflow ${i + 1}:`, r.text));

        // Check execution tracking
        const statusResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Show me the status of all running workflows',
          30000
        );

        console.log('Status check:', statusResponse.text);

        // Verify multiple executions tracked
        assert.match(
          statusResponse.text || '',
          /multiple|concurrent|running|executing|3.*workflow/i,
          'Should track multiple concurrent executions'
        );

        console.log('✓ Concurrent execution test passed');
      },
    },

    {
      name: 'Test 5: Cache Invalidation and Refresh',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Cache Invalidation Test ===');

        // Get cached data
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Get current weather for Paris and cache it',
          60000
        );

        console.log('Initial request:', response1.text);

        // Force cache invalidation
        const response2 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Clear the weather cache and get fresh data for Paris',
          60000
        );

        console.log('Cache invalidation:', response2.text);

        // Verify fresh data fetch
        assert.match(
          response2.text || '',
          /clear|invalidat|fresh|new.*data|refresh|updated/i,
          'Should indicate cache was cleared and fresh data fetched'
        );

        // Verify different data or timestamp
        assert.match(
          response2.text || '',
          /updated|new|fresh|latest|current/i,
          'Should indicate data is fresh'
        );

        console.log('✓ Cache invalidation test passed');
      },
    },

    {
      name: 'Test 6: Execution History and Logs',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Execution History Test ===');

        // Create and run a workflow
        await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Create a simple workflow that logs "Hello World"',
          60000
        );

        await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Run the Hello World workflow',
          30000
        );

        // Check execution history
        const historyResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Show me the execution history for the last hour',
          30000
        );

        console.log('Execution history:', historyResponse.text);

        // Verify history tracking
        assert.match(
          historyResponse.text || '',
          /execution|history|ran|completed|log/i,
          'Should show execution history'
        );

        assert.match(
          historyResponse.text || '',
          /hello.*world|workflow.*executed/i,
          'Should show specific workflow execution'
        );

        console.log('✓ Execution history test passed');
      },
    },
  ],
};

export default n8nPersistenceSuite;
