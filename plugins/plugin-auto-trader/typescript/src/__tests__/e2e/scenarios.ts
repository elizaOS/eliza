// A comment to trigger the linter
import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { strict as assert } from 'node:assert';
import { setupScenario, sendMessageAndWaitForResponse } from './test-utils.ts';

/**
 * Defines a suite of E2E tests for basic agent conversational scenarios.
 */
const agentScenarios = [
  {
    name: "should respond with 'hello world' when asked",
    fn: async (runtime: IAgentRuntime) => {
      // 1. Setup
      const { user, room } = await setupScenario(runtime);

      // 2. Act
      const response = await sendMessageAndWaitForResponse(
        runtime,
        room,
        user,
        'please say hello world'
      );

      // 3. Assert and Log
      console.log('Agent Response Text:', response.text); // Log the response text

      assert(
        typeof response.text === 'string' && response.text.length > 0,
        'Agent response should have a non-empty text property.'
      );
      assert.match(
        response.text,
        /hello world/i,
        `Expected response to contain 'hello world', but got: "${response.text}"`
      );
    },
  },
];

const agentScenariosSuite: TestSuite = {
  name: 'Agent Trading Scenarios',
  tests: agentScenarios,
};

export default agentScenariosSuite;
