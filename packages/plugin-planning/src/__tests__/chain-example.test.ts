import { describe, it, expect, vi } from 'vitest';
import {
  analyzeInputAction,
  processAnalysisAction,
  executeFinalAction,
} from '../actions/chain-example';
import { ActionOptions, ActionResult } from '@elizaos/core';

describe('Action Chaining', () => {
  const mockRuntime = {
    agentId: 'test-agent',
    character: { name: 'Test Agent' },
  };

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

  it('should pass data between actions', async () => {
    // Execute first action
    const result1 = await analyzeInputAction.handler(
      mockRuntime as any,
      mockMessage as any,
      mockState,
      {}
    );

    expect(result1).toBeDefined();
    expect((result1 as ActionResult)?.success).toBe(true);
    expect((result1 as ActionResult)?.data).toBeDefined();
    expect((result1 as ActionResult)?.data.sentiment).toBe('positive');
    expect((result1 as ActionResult)?.continueChain).toBe(true);

    // Execute second action with previous results
    const options2: ActionOptions = {
      previousResults: [result1 as ActionResult],
    };

    const result2 = await processAnalysisAction.handler(
      mockRuntime as any,
      mockMessage as any,
      mockState,
      options2
    );

    expect((result2 as ActionResult)?.success).toBe(true);
    expect((result2 as ActionResult)?.data?.analysis).toEqual((result1 as ActionResult)?.data);
    expect((result2 as ActionResult)?.data?.decisions.suggestedResponse).toBe(
      'Thank you for the positive feedback!'
    );

    // Execute final action with all previous results
    const options3: ActionOptions = {
      previousResults: [result1 as ActionResult, result2 as ActionResult],
      chainContext: {
        chainId: 'test-chain',
        totalActions: 3,
        currentIndex: 2,
      },
    };

    const mockCallback = vi.fn();
    const result3 = await executeFinalAction.handler(
      mockRuntime as any,
      mockMessage as any,
      mockState,
      options3,
      mockCallback
    );

    expect(result3?.success).toBe(true);
    expect(result3?.continueChain).toBe(false); // End of chain
    expect(mockCallback).toHaveBeenCalledWith({
      text: 'Thank you for the positive feedback!',
      source: 'chain_example',
    });
  });

  it('should handle abort signals', async () => {
    const abortController = new AbortController();

    // Abort immediately
    abortController.abort();

    const options: ActionOptions = {
      abortSignal: abortController.signal,
    };

    await expect(
      analyzeInputAction.handler(mockRuntime as any, mockMessage as any, mockState, options)
    ).rejects.toThrow('Analysis aborted');
  });

  it('should stop chain when continueChain is false', async () => {
    // Create a message that will trigger needsMoreInfo
    const shortMessage = {
      ...mockMessage,
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
  });

  it('should handle missing previous results', async () => {
    await expect(
      processAnalysisAction.handler(
        mockRuntime as any,
        mockMessage as any,
        mockState,
        {} // No previous results
      )
    ).rejects.toThrow('No analysis data available');
  });

  it('should execute cleanup functions', async () => {
    const cleanupMock = vi.fn();
    console.log = vi.fn(); // Mock console.log

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
  });
});
