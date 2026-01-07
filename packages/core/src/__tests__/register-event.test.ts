import { describe, it, expect, beforeEach } from 'bun:test';
import { AgentRuntime } from '../runtime';
import type { Character, EventPayload } from '../types';
import { stringToUuid } from '../utils';

interface CustomEventPayload extends EventPayload {
  customField: string;
  count: number;
}

describe('registerEvent', () => {
  let runtime: AgentRuntime;

  const mockCharacter: Character = {
    id: stringToUuid('test-character'),
    name: 'TestBot',
    bio: 'A test bot',
  };

  beforeEach(() => {
    runtime = new AgentRuntime({
      character: mockCharacter,
    });
  });

  it('should register and emit custom typed events', async () => {
    const receivedPayloads: CustomEventPayload[] = [];

    runtime.registerEvent<CustomEventPayload>('CUSTOM_EVENT', async (params) => {
      receivedPayloads.push(params);
    });

    await runtime.emitEvent('CUSTOM_EVENT', {
      customField: 'test-value',
      count: 42,
    });

    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0].customField).toBe('test-value');
    expect(receivedPayloads[0].count).toBe(42);
    // emitEvent injects runtime and source
    expect(receivedPayloads[0].runtime).toBeDefined();
    expect(receivedPayloads[0].source).toBeDefined();
  });

  it('should support multiple handlers for same event', async () => {
    let handler1Called = false;
    let handler2Called = false;

    runtime.registerEvent<CustomEventPayload>('MULTI_HANDLER_EVENT', async () => {
      handler1Called = true;
    });

    runtime.registerEvent<CustomEventPayload>('MULTI_HANDLER_EVENT', async () => {
      handler2Called = true;
    });

    await runtime.emitEvent('MULTI_HANDLER_EVENT', {
      customField: 'test',
      count: 1,
    });

    expect(handler1Called).toBe(true);
    expect(handler2Called).toBe(true);
  });
});
