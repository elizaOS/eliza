import { type IAgentRuntime, Service } from '@elizaos/core';
import type { ITunnelService } from '@elizaos/plugin-tunnel';

// Local mock implementation until core test-utils build issue is resolved
const mock = () => {
  const calls: any[][] = [];
  const fn = (...args: any[]) => {
    calls.push(args);
    if (typeof fn._implementation === 'function') {
      return fn._implementation(...args);
    }
    return fn._returnValue;
  };
  fn.calls = calls;
  fn._returnValue = undefined;
  fn._implementation = null;
  fn.mockReturnValue = (value: any) => {
    fn._returnValue = value;
    fn._implementation = null;
    return fn;
  };
  fn.mockResolvedValue = (value: any) => {
    fn._returnValue = Promise.resolve(value);
    fn._implementation = null;
    return fn;
  };
  fn.mockRejectedValue = (error: any) => {
    fn._returnValue = Promise.reject(error);
    fn._implementation = null;
    return fn;
  };
  fn.mockImplementation = (impl: any) => {
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
  startTunnel = mock();
  stopTunnel = mock();
  getUrl = mock();
  isActive = mock();
  getStatus = mock();

  // Base Service methods
  async start(): Promise<void> {}
  async stop(): Promise<void> {
    await this.stopTunnel();
  }
}

export function createMockNgrokService(runtime: IAgentRuntime): MockNgrokService {
  return new MockNgrokService(runtime);
}
