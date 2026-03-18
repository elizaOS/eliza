import { vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

type MockFn = ReturnType<typeof vi.fn>;

export interface MockRuntimeOptions {
  agentId?: string;
  services?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  useModel?: MockFn;
  cache?: Record<string, unknown>;
}

/**
 * Create a useModel mock that handles both structured (schema) and text (formatting) calls.
 *
 * - Schema calls (OBJECT_SMALL) → return schemaResult
 * - Text calls (TEXT_SMALL for formatActionResponse) → return the data section from the prompt
 *   so tests can verify that the right data was passed to the LLM
 */
export function createUseModelMock(schemaResult?: Record<string, unknown>) {
  return vi.fn((_type: string, opts: Record<string, unknown>) => {
    // Schema-based calls (intent classification, keyword extraction)
    if (opts?.schema) return Promise.resolve(schemaResult || {});

    // Text calls (response formatting) — extract and return the data section
    const prompt = (opts?.prompt || "") as string;
    const dataIdx = prompt.lastIndexOf("\n\n{");
    if (dataIdx !== -1) return Promise.resolve(prompt.slice(dataIdx + 2));

    return Promise.resolve("");
  });
}

export function createMockRuntime(options: MockRuntimeOptions = {}): IAgentRuntime {
  const services = options.services || {};
  const settings = options.settings || {};
  const cache: Record<string, unknown> = options.cache || {};

  return {
    agentId: options.agentId || "agent-001",
    getService: vi.fn((type: string) => services[type] || null),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    useModel: options.useModel || createUseModelMock(),
    getCache: vi.fn((key: string) => Promise.resolve(cache[key])),
    setCache: vi.fn((key: string, value: unknown) => {
      cache[key] = value;
      return Promise.resolve(true);
    }),
    deleteCache: vi.fn((key: string) => {
      delete cache[key];
      return Promise.resolve(true);
    }),
  } as unknown as IAgentRuntime;
}

export function createMockMessage(overrides?: Partial<Memory>): Memory {
  return {
    id: "msg-001",
    entityId: "user-001",
    agentId: "agent-001",
    roomId: "room-001",
    content: { text: "Test message" },
    createdAt: Date.now(),
    ...overrides,
  } as Memory;
}

export function createMockState(overrides?: Partial<State>): State {
  return {
    data: {},
    values: {},
    text: "",
    ...overrides,
  } as State;
}

export function createMockCallback() {
  return vi.fn((_response: { text: string; success?: boolean }) => Promise.resolve([]));
}

/**
 * Interface for accessing mock function internals
 */
interface MockFnWithCalls extends MockFn {
  mock: {
    calls: Array<[{ text: string; success?: boolean }]>;
  };
}

/**
 * Helper to get the last callback result with both text and success status
 */
export function getLastCallbackResult(
  callback: MockFn
): { text: string; success?: boolean } | undefined {
  const mockWithCalls = callback as unknown as MockFnWithCalls;
  const calls = mockWithCalls.mock.calls;
  if (calls.length === 0) return undefined;
  return calls[calls.length - 1][0];
}

/**
 * Helper to get all callback results with proper typing
 */
export function getAllCallbackResults(
  callback: MockFn
): Array<{ text: string; success?: boolean }> {
  const mockWithCalls = callback as unknown as MockFnWithCalls;
  const calls = mockWithCalls.mock.calls;
  return calls.map((call) => call[0]);
}

/**
 * Helper to get a callback result at a specific index
 */
export function getCallbackResultAt(
  callback: MockFn,
  index: number
): { text: string; success?: boolean } | undefined {
  const mockWithCalls = callback as unknown as MockFnWithCalls;
  const calls = mockWithCalls.mock.calls;
  if (index < 0 || index >= calls.length) return undefined;
  return calls[index][0];
}

/**
 * Helper to get the count of callback calls
 */
export function getCallbackCallCount(callback: MockFn): number {
  const mockWithCalls = callback as unknown as MockFnWithCalls;
  return mockWithCalls.mock.calls.length;
}
