import { describe, it, expect, mock } from 'bun:test';
import {
  analyzeInputAction,
  processAnalysisAction,
  executeFinalAction,
} from '../actions/chain-example';
import { ActionResult } from '@elizaos/core';
import { createMockRuntime } from '@elizaos/core/test-utils';

// Simplified TestSuite implementation for local use
class TestSuite {
  constructor(
    private name: string,
    private config: any
  ) {}

  addTest(test: any) {
    it(test.name, async () => {
      const context = this.config.beforeEach ? this.config.beforeEach() : {};
      await test.fn(context);
    });
  }

  run() {
    // No-op, bun:test handles execution
  }
}

const createUnitTest = (config: { name: string; fn: (context?: any) => Promise<void> | void }) =>
  config;

interface ActionOptions {
  abortSignal?: AbortSignal;
  previousResults?: ActionResult[];
  chainContext?: {
    chainId: string;
    totalActions: number;
    currentIndex: number;
  };
}

describe('Action Chaining', () => {
  const actionChainingSuite = new TestSuite('Action Chaining', {
    beforeEach: () => {
      const mockRuntime = createMockRuntime({
        character: { name: 'Test Agent' },
      });

      const mockMessage = {
        id: 'test-message',
        entityId: 'test-entity',
        roomId: 'test-room',
        content: {
          text: 'This is a good test message',
        },
      };

      const mockState = {
        values: {},
        data: {},
        text: '',
      };

      return { mockRuntime, mockMessage, mockState };
    },
  });

  actionChainingSuite.addTest(
    createUnitTest({
      name: 'should pass data between actions',
      fn: async ({ mockRuntime, mockMessage, mockState }) => {
        // Execute first action
        const result1 = await analyzeInputAction.handler(
          mockRuntime as any,
          mockMessage as any,
          mockState,
          {}
        );

        expect(result1).toBeDefined();
        expect((result1 as ActionResult)?.data).toBeDefined();
        expect((result1 as ActionResult)?.data.sentiment).toBe('positive');
        expect((result1 as ActionResult)?.text).toContain('positive sentiment');

        // Execute second action with previous results
        const options2 = {
          previousResults: [result1 as ActionResult],
        };

        const result2 = await processAnalysisAction.handler(
          mockRuntime as any,
          mockMessage as any,
          mockState,
          options2
        );

        expect((result2 as ActionResult)?.data).toBeDefined();
        expect((result2 as ActionResult)?.data?.analysis).toEqual((result1 as ActionResult)?.data);
        expect((result2 as ActionResult)?.data?.decisions.suggestedResponse).toBe(
          'Thank you for the positive feedback!'
        );

        // Execute final action with all previous results
        const options3 = {
          previousResults: [result1 as ActionResult, result2 as ActionResult],
          chainContext: {
            chainId: 'test-chain',
            totalActions: 3,
            currentIndex: 2,
          },
        };

        const mockCallback = mock();
        const result3 = await executeFinalAction.handler(
          mockRuntime as any,
          mockMessage as any,
          mockState,
          options3,
          mockCallback
        );

        expect(result3).toBeDefined();
        expect((result3 as ActionResult)?.data).toBeDefined();
        expect(mockCallback).toHaveBeenCalledWith({
          text: 'Thank you for the positive feedback!',
          source: 'chain_example',
        });
      },
    })
  );

  actionChainingSuite.addTest(
    createUnitTest({
      name: 'should handle abort signals',
      fn: async ({ mockRuntime, mockMessage, mockState }) => {
        const abortController = new AbortController();

        // Abort immediately
        abortController.abort();

        const options: ActionOptions = {
          abortSignal: abortController.signal,
        };

        await expect(
          analyzeInputAction.handler(mockRuntime as any, mockMessage as any, mockState, options)
        ).rejects.toThrow('Analysis aborted');
      },
    })
  );

  actionChainingSuite.addTest(
    createUnitTest({
      name: 'should stop chain when continueChain is false',
      fn: async ({ mockRuntime, mockState }) => {
        // Create a message that will trigger needsMoreInfo
        const shortMessage = {
          id: 'test-message',
          entityId: 'test-entity',
          roomId: 'test-room',
          content: { text: 'Hi' },
        };

        // First action
        const result1 = await analyzeInputAction.handler(
          mockRuntime as any,
          shortMessage as any,
          mockState,
          {}
        );

        // Second action should return continueChain: false
        const options2: ActionOptions = {
          previousResults: [result1 as ActionResult],
        };

        const result2 = await processAnalysisAction.handler(
          mockRuntime as any,
          shortMessage as any,
          mockState,
          options2
        );

        expect(result2?.continueChain).toBe(false);
        expect(result2?.data?.decisions.needsMoreInfo).toBe(true);
      },
    })
  );

  actionChainingSuite.addTest(
    createUnitTest({
      name: 'should handle missing previous results',
      fn: async ({ mockRuntime, mockMessage, mockState }) => {
        await expect(
          processAnalysisAction.handler(
            mockRuntime as any,
            mockMessage as any,
            mockState,
            {} // No previous results
          )
        ).rejects.toThrow('No analysis data available');
      },
    })
  );

  actionChainingSuite.addTest(
    createUnitTest({
      name: 'should execute cleanup functions',
      fn: async ({ mockRuntime, mockMessage, mockState }) => {
        const cleanupMock = mock();
        console.log = mock(); // Mock console.log

        const result = await executeFinalAction.handler(
          mockRuntime as any,
          mockMessage as any,
          mockState,
          {
            previousResults: [
              { success: true, data: { wordCount: 10 } },
              {
                success: true,
                data: {
                  decisions: {
                    requiresAction: true,
                    suggestedResponse: 'Test response',
                  },
                },
                metadata: { action: 'PROCESS_ANALYSIS' },
              },
            ],
          }
        );

        expect(result?.cleanup).toBeDefined();

        // Execute cleanup
        await result?.cleanup?.();

        expect(console.log).toHaveBeenCalledWith('[ChainExample] Cleaning up resources...');
      },
    })
  );

  actionChainingSuite.run();
});
