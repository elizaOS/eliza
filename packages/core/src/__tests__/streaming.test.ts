import { describe, it, expect, beforeEach } from 'bun:test';
import { AgentRuntime } from '../runtime';
import { ModelType, type IAgentRuntime } from '../types';

describe('AgentRuntime streaming', () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    runtime = new AgentRuntime({
      character: {
        name: 'TestAgent',
        bio: 'Streaming tests',
      } as any,
    });
  });

  it('streams text with a registered streaming handler (TEXT_SMALL)', async () => {
    // Register a streaming model that yields two deltas then finish
    (runtime as unknown as IAgentRuntime).registerModelStream(
      ModelType.TEXT_SMALL,
      async function* (params: { prompt: string }) {
        expect(params.prompt).toBe('Hello');
        yield { event: 'delta', delta: 'He' } as any;
        yield { event: 'delta', delta: 'llo' } as any;
        yield { event: 'usage', tokens: { prompt: 2, completion: 3, total: 5 } } as any;
        yield { event: 'finish', output: 'Hello' } as any;
      },
      'test-provider',
      100
    );

    const chunks: any[] = [];
    for await (const chunk of (await (runtime as unknown as IAgentRuntime).useModel(
      ModelType.TEXT_SMALL,
      { prompt: 'Hello' },
      'STREAMING_TEXT'
    )) as AsyncIterable<any>) {
      chunks.push(chunk);
    }

    // Expect two deltas, one usage, one finish
    const events = chunks.map((c) => c.event);
    expect(events).toEqual(['delta', 'delta', 'usage', 'finish']);
    const final = chunks[chunks.length - 1];
    expect(final.output).toBe('Hello');
  });

  it('falls back to a single finish chunk when no streaming handler is registered', async () => {
    // Register a non-streaming model handler
    runtime.registerModel(
      ModelType.TEXT_SMALL,
      async (_params: { prompt: string }) => {
        return 'non-streamed';
      },
      'test-provider',
      50
    );

    // Minimal adapter stub so useModel() can log without throwing
    (runtime as any).adapter = {
      log: async () => {},
    } as any;

    const chunks: any[] = [];
    for await (const chunk of (await (runtime as unknown as IAgentRuntime).useModel(
      ModelType.TEXT_SMALL,
      { prompt: 'Hi' },
      'STREAMING_TEXT'
    )) as AsyncIterable<any>) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(1);
    expect(chunks[0].event).toBe('finish');
    expect(chunks[0].output).toBe('non-streamed');
  });

  it('emits model:stream events during streaming', async () => {
    const seenEvents: { chunk: any }[] = [];
    runtime.registerEvent('model:stream:chunk', async (data: any) => {
      if (data?.chunk?.event === 'delta') {
        seenEvents.push({ chunk: data.chunk });
      }
    });

    (runtime as unknown as IAgentRuntime).registerModelStream(
      ModelType.TEXT_LARGE,
      async function* () {
        yield { event: 'delta', delta: 'A' } as any;
        yield { event: 'delta', delta: 'B' } as any;
        yield { event: 'finish', output: 'AB' } as any;
      },
      'test-provider',
      100
    );

    const received: any[] = [];
    for await (const chunk of (await (runtime as unknown as IAgentRuntime).useModel(
      ModelType.TEXT_LARGE,
      { prompt: 'x' },
      'STREAMING_TEXT'
    )) as AsyncIterable<any>) {
      received.push(chunk);
    }

    // Verify both chunks observed via emitted events
    expect(seenEvents.length).toBe(2);
    expect(seenEvents[0].chunk).toEqual({ event: 'delta', delta: 'A' });
    expect(seenEvents[1].chunk).toEqual({ event: 'delta', delta: 'B' });
    expect(received[received.length - 1].output).toBe('AB');
  });
});


