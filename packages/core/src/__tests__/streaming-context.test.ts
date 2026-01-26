import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  runWithStreamingContext,
  getStreamingContext,
  setStreamingContextManager,
  getStreamingContextManager,
  type StreamingContext,
  type IStreamingContextManager,
} from '../streaming-context';
import { createNodeStreamingContextManager } from '../streaming-context.node';

describe('Streaming Context', () => {
  let originalManager: IStreamingContextManager;

  beforeEach(() => {
    // Store original manager
    originalManager = getStreamingContextManager();
    // Configure Node.js AsyncLocalStorage manager for tests
    setStreamingContextManager(createNodeStreamingContextManager());
  });

  afterEach(() => {
    // Restore original manager
    setStreamingContextManager(originalManager);
  });

  describe('runWithStreamingContext', () => {
    it('should make context available within the callback', async () => {
      const chunks: string[] = [];
      const testMessageId = 'test-test-test-test-test' as any;
      const context: StreamingContext = {
        onStreamChunk: async (chunk): Promise<void> => {
          chunks.push(chunk);
        },
        messageId: testMessageId,
      };

      let capturedContext: StreamingContext | undefined;

      runWithStreamingContext(context, () => {
        capturedContext = getStreamingContext();
      });

      expect(capturedContext).toBeDefined();
      expect(capturedContext?.messageId).toBe(testMessageId);
      expect(capturedContext?.onStreamChunk).toBe(context.onStreamChunk);
    });

    it('should return undefined outside of context', () => {
      const context = getStreamingContext();
      expect(context).toBeUndefined();
    });

    it('should handle undefined context', () => {
      runWithStreamingContext(undefined, () => {
        const context = getStreamingContext();
        expect(context).toBeUndefined();
      });
    });

    it('should return the result of the callback', () => {
      const result = runWithStreamingContext(undefined, () => {
        return 'test-result';
      });

      expect(result).toBe('test-result');
    });

    it('should propagate errors from callback', () => {
      expect(() => {
        runWithStreamingContext(undefined, () => {
          throw new Error('Test error');
        });
      }).toThrow('Test error');
    });

    it('should work with async callbacks', async () => {
      const chunks: string[] = [];
      const context: StreamingContext = {
        onStreamChunk: async (chunk) => {
          chunks.push(chunk);
        },
      };

      const result = await runWithStreamingContext(context, async () => {
        const ctx = getStreamingContext();
        await ctx?.onStreamChunk('chunk1');
        await ctx?.onStreamChunk('chunk2');
        return 'async-result';
      });

      expect(result).toBe('async-result');
      expect(chunks).toEqual(['chunk1', 'chunk2']);
    });

    it('should isolate context in parallel operations', async () => {
      const chunks1: string[] = [];
      const chunks2: string[] = [];

      const context1: StreamingContext = {
        onStreamChunk: async (chunk): Promise<void> => {
          chunks1.push(chunk);
        },
        messageId: 'msg1-msg1-msg1-msg1-msg1' as any,
      };

      const context2: StreamingContext = {
        onStreamChunk: async (chunk): Promise<void> => {
          chunks2.push(chunk);
        },
        messageId: 'msg2-msg2-msg2-msg2-msg2' as any,
      };

      // Run two contexts in parallel
      const [result1, result2] = await Promise.all([
        runWithStreamingContext(context1, async () => {
          await new Promise((r) => setTimeout(r, 10));
          const ctx = getStreamingContext();
          await ctx?.onStreamChunk('from-context-1');
          return ctx?.messageId;
        }),
        runWithStreamingContext(context2, async () => {
          await new Promise((r) => setTimeout(r, 5));
          const ctx = getStreamingContext();
          await ctx?.onStreamChunk('from-context-2');
          return ctx?.messageId;
        }),
      ]);

      // Each context should have its own isolated data
      expect(result1).toBe('msg1-msg1-msg1-msg1-msg1');
      expect(result2).toBe('msg2-msg2-msg2-msg2-msg2');
      expect(chunks1).toEqual(['from-context-1']);
      expect(chunks2).toEqual(['from-context-2']);
    });

    it('should support nested contexts', () => {
      const outerChunks: string[] = [];
      const innerChunks: string[] = [];

      const outerContext: StreamingContext = {
        onStreamChunk: async (chunk): Promise<void> => {
          outerChunks.push(chunk);
        },
        messageId: 'outer-outer-outer-outer-outer' as any,
      };

      const innerContext: StreamingContext = {
        onStreamChunk: async (chunk): Promise<void> => {
          innerChunks.push(chunk);
        },
        messageId: 'inner-inner-inner-inner-inner' as any,
      };

      runWithStreamingContext(outerContext, () => {
        expect(getStreamingContext()?.messageId).toBe('outer-outer-outer-outer-outer');

        runWithStreamingContext(innerContext, () => {
          expect(getStreamingContext()?.messageId).toBe('inner-inner-inner-inner-inner');
        });

        // Back to outer context
        expect(getStreamingContext()?.messageId).toBe('outer-outer-outer-outer-outer');
      });
    });
  });

  describe('NoopContextManager', () => {
    it('should return undefined when no manager is configured', () => {
      // Use a noop manager
      const noopManager: IStreamingContextManager = {
        run: <T>(_ctx: StreamingContext | undefined, fn: () => T) => fn(),
        active: () => undefined,
      };
      setStreamingContextManager(noopManager);

      const context: StreamingContext = {
        onStreamChunk: async () => {},
      };

      runWithStreamingContext(context, () => {
        // Even with context passed, noop manager returns undefined
        expect(getStreamingContext()).toBeUndefined();
      });
    });
  });
});
