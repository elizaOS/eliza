import { type IAgentRuntime, Service } from '@elizaos/core';
import type { ITunnelService } from '@elizaos/plugin-tunnel';

type MockImplementation<TArgs extends unknown[], TResult> = (...args: TArgs) => TResult;

type MockFunction<TArgs extends unknown[], TResult> = MockImplementation<TArgs, TResult> & {
  calls: TArgs[];
  _returnValue: TResult | undefined;
  _implementation: MockImplementation<TArgs, TResult> | null;
  mockReturnValue: (value: TResult) => MockFunction<TArgs, TResult>;
  mockResolvedValue: (value: Awaited<TResult>) => MockFunction<TArgs, TResult>;
  mockRejectedValue: (error: unknown) => MockFunction<TArgs, TResult>;
  mockImplementation: (
    implementation: MockImplementation<TArgs, TResult>
  ) => MockFunction<TArgs, TResult>;
  mock: { calls: TArgs[]; results: unknown[] };
};

// Local mock implementation until core test-utils build issue is resolved
const mock = <TArgs extends unknown[], TResult>(): MockFunction<TArgs, TResult> => {
  const calls: TArgs[] = [];
  const fn = ((...args: TArgs) => {
    calls.push(args);
    if (typeof fn._implementation === 'function') {
      return fn._implementation(...args);
    }
    return fn._returnValue as TResult;
  }) as MockFunction<TArgs, TResult>;
  fn.calls = calls;
  fn._returnValue = undefined;
  fn._implementation = null;
  fn.mockReturnValue = (value: TResult) => {
    fn._returnValue = value;
    fn._implementation = null;
    return fn;
  };
  fn.mockResolvedValue = (value: Awaited<TResult>) => {
    fn._returnValue = Promise.resolve(value) as TResult;
    fn._implementation = null;
    return fn;
  };
  fn.mockRejectedValue = (error: unknown) => {
    fn._returnValue = Promise.reject(error) as TResult;
    fn._implementation = null;
    return fn;
  };
  fn.mockImplementation = (impl: MockImplementation<TArgs, TResult>) => {
    fn._implementation = impl;
    fn._returnValue = undefined;
    return fn;
  };
  fn.mock = { calls, results: [] };
  return fn;
};

export class MockNgrokService extends Service implements ITunnelService {
  static serviceType = 'tunnel';
  readonly capabilityDescription = 'Mock tunnel service for testing';

  // Mock functions to track calls - no default implementations so tests can override
  startTunnel = mock<[number?], Promise<string | undefined>>();
  stopTunnel = mock<[], Promise<void>>();
  getUrl = mock<[], string | null>();
  isActive = mock<[], boolean>();
  getStatus = mock<[], ReturnType<ITunnelService['getStatus']>>();

  // Base Service methods
  async start(): Promise<void> {}
  async stop(): Promise<void> {
    await this.stopTunnel();
  }
}

export function createMockNgrokService(runtime: IAgentRuntime): MockNgrokService {
  return new MockNgrokService(runtime);
}
