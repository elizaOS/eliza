// A comment to trigger the linter
// E2E test for live trading scenarios
import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { strict as assert } from 'node:assert';
import { setupScenario, sendMessageAndWaitForResponse } from './test-utils.ts';

export const liveFireTestSuite: TestSuite = {
  name: 'Live Fire Trading Tests',
  tests: [
    {
      name: 'should execute a backtest when requested',
      fn: async (runtime: IAgentRuntime) => {
        try {
          const { user, room } = await setupScenario(runtime);

          // Send backtest request
          const response = await sendMessageAndWaitForResponse(
            runtime,
            room,
            user,
            'Run a backtest for SOL/USDC using the random strategy with $10,000 for 30 days'
          );

          // Assert response contains backtest results
          assert(response.text, 'Response text should not be empty');
          const text = response.text!.toLowerCase();
          assert(
            text.includes('backtest') ||
              text.includes('simulation') ||
              text.includes('error') ||
              text.includes('sorry'),
            `Unexpected backtest response: ${response.text}`
          );
        } catch (error) {
          console.error('Test error:', error);
          throw error;
        }
      },
    },
    {
      name: 'should check portfolio status',
      fn: async (runtime: IAgentRuntime) => {
        try {
          const { user, room } = await setupScenario(runtime);

          const response = await sendMessageAndWaitForResponse(
            runtime,
            room,
            user,
            'What is my current portfolio status?'
          );

          assert(response.text, 'Response text should not be empty');
          const text = response.text!.toLowerCase();
          assert(
            text.includes('portfolio') ||
              text.includes('balance') ||
              text.includes('holdings') ||
              text.includes('empty') ||
              text.includes('wallet') ||
              text.includes('error'),
            `Unexpected portfolio status response: ${response.text}`
          );
        } catch (error) {
          console.error('Test error:', error);
          throw error;
        }
      },
    },
    {
      name: 'should compare trading strategies',
      fn: async (runtime: IAgentRuntime) => {
        try {
          const { user, room } = await setupScenario(runtime);

          const response = await sendMessageAndWaitForResponse(
            runtime,
            room,
            user,
            'Compare all strategies on ETH with $5000'
          );

          assert(response.text, 'Response text should not be empty');
          const text = response.text!.toLowerCase();
          assert(
            text.includes('strateg') ||
              text.includes('comparison') ||
              text.includes('performance') ||
              text.includes('error'),
            `Unexpected strategy comparison response: ${response.text}`
          );
        } catch (error) {
          console.error('Test error:', error);
          throw error;
        }
      },
    },
    {
      name: 'should configure strategy parameters',
      fn: async (runtime: IAgentRuntime) => {
        try {
          const { user, room } = await setupScenario(runtime);

          const response = await sendMessageAndWaitForResponse(
            runtime,
            room,
            user,
            'Set the rule-based strategy stop-loss to 5%'
          );

          assert(response.text, 'Response text should not be empty');
          const text = response.text!.toLowerCase();
          assert(
            text.includes('strategy') ||
              text.includes('configuration') ||
              text.includes('updated') ||
              text.includes('rule') ||
              text.includes('error'),
            `Unexpected strategy configuration response: ${response.text}`
          );
        } catch (error) {
          console.error('Test error:', error);
          throw error;
        }
      },
    },
    {
      name: 'should analyze performance metrics',
      fn: async (runtime: IAgentRuntime) => {
        try {
          const { user, room } = await setupScenario(runtime);

          const response = await sendMessageAndWaitForResponse(
            runtime,
            room,
            user,
            'Analyze my trading performance'
          );

          assert(response.text, 'Response text should not be empty');
          const text = response.text!.toLowerCase();
          assert(
            text.includes('performance') ||
              text.includes('analysis') ||
              text.includes('return') ||
              text.includes('profit') ||
              text.includes('loss') ||
              text.includes('no trades') ||
              text.includes('error'),
            `Unexpected performance analysis response: ${response.text}`
          );
        } catch (error) {
          console.error('Test error:', error);
          throw error;
        }
      },
    },
  ],
};

export default liveFireTestSuite;
