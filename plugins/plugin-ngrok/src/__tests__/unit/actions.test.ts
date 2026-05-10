import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core';

type SimpleMock<TArgs extends readonly unknown[] = unknown[], TReturn = unknown> = ((
  ...args: TArgs
) => TReturn) & {
  calls: TArgs[];
  _returnValue: TReturn | undefined;
  _implementation: ((...args: unknown[]) => TReturn) | null;
  mockReturnValue: (value: TReturn) => SimpleMock<TArgs, TReturn>;
  mockResolvedValue: (value: Awaited<TReturn>) => SimpleMock<TArgs, TReturn>;
  mockRejectedValue: (reason: unknown) => SimpleMock<TArgs, TReturn>;
  mockImplementation: (impl: (...args: unknown[]) => TReturn) => SimpleMock<TArgs, TReturn>;
  mock: { calls: TArgs[]; results: unknown[] };
};

// Use local mock implementation until core test-utils build issue is resolved
const mock = <const TArgs extends readonly unknown[] = unknown[], TReturn = unknown>(): SimpleMock<
  TArgs,
  TReturn
> => {
  const calls: TArgs[] = [];
  const fn = ((...args: TArgs) => {
    calls.push(args);
    if (typeof fn._implementation === 'function') {
      return fn._implementation(...args);
    }
    return fn._returnValue as TReturn;
  }) as SimpleMock<TArgs, TReturn>;
  fn.calls = calls;
  fn._returnValue = undefined;
  fn._implementation = null;
  fn.mockReturnValue = (value: TReturn) => {
    fn._returnValue = value;
    fn._implementation = null;
    return fn;
  };
  fn.mockResolvedValue = (value: Awaited<TReturn>) => {
    fn._returnValue = Promise.resolve(value) as TReturn;
    fn._implementation = null;
    return fn;
  };
  fn.mockRejectedValue = (reason: unknown) => {
    fn._returnValue = Promise.reject(reason) as TReturn;
    fn._implementation = null;
    return fn;
  };
  fn.mockImplementation = (impl: (...args: unknown[]) => TReturn) => {
    fn._implementation = impl;
    fn._returnValue = undefined;
    return fn;
  };
  fn.mock = { calls, results: [] };
  return fn;
};

import { getTunnelStatusAction } from '../../actions/get-tunnel-status';
import { startTunnelAction } from '../../actions/start-tunnel';
import { stopTunnelAction } from '../../actions/stop-tunnel';
import { MockNgrokService } from '../mocks/NgrokServiceMock';
import { createMockMemory, createMockRuntime, createMockState } from '../test-utils';

describe('Ngrok Actions - Validation and Error Handling', () => {
  let mockRuntime: IAgentRuntime;
  let mockTunnelService: MockNgrokService;
  let mockCallback: HandlerCallback;
  let mockMemory: Memory;
  let mockState: State;
  let mockUseModel: ReturnType<typeof mock>;

  beforeEach(() => {
    mockTunnelService = new MockNgrokService({} as IAgentRuntime);

    // Reset all mocks to default behavior
    mockTunnelService.startTunnel.mockResolvedValue('https://test.ngrok.io');
    mockTunnelService.stopTunnel.mockResolvedValue(undefined);
    mockTunnelService.isActive.mockReturnValue(false);
    mockTunnelService.getStatus.mockReturnValue({
      active: false,
      url: null,
      port: null,
      startedAt: null,
      provider: 'ngrok',
    });

    mockUseModel = mock().mockResolvedValue('{"port": 8080}');
    mockRuntime = createMockRuntime({
      getService: mock().mockImplementation((name: string) => {
        if (name === 'tunnel' || name === 'ngrok-tunnel') {
          return mockTunnelService;
        }
        return null;
      }),
      useModel: mockUseModel,
    });

    mockCallback = mock();
    mockMemory = createMockMemory();
    mockState = createMockState();
  });

  afterEach(() => {
    // Clear any mock state between tests
  });

  describe('startTunnelAction - Validation', () => {
    it('should validate that tunnel service exists', async () => {
      const runtimeWithoutService = createMockRuntime({
        getService: mock().mockReturnValue(null),
      });

      const isValid = await startTunnelAction.validate(runtimeWithoutService, mockMemory);

      expect(isValid).toBe(false);
    });

    it('should validate when tunnel service is available', async () => {
      const isValid = await startTunnelAction.validate(mockRuntime, mockMemory);

      expect(isValid).toBe(true);
    });
  });

  describe('startTunnelAction - Error Handling', () => {
    it('should handle service not available', async () => {
      const runtimeWithoutService = createMockRuntime({
        getService: mock().mockReturnValue(null),
      });
      const memory = createMockMemory({
        content: { text: 'start tunnel on port 8080' },
      });

      const result = await startTunnelAction.handler(
        runtimeWithoutService,
        memory,
        mockState,
        {},
        mockCallback
      );

      expect(result.values?.success).toBe(false);
      expect(result.values?.error).toBe('service_unavailable');
      expect(mockCallback.calls.length).toBeGreaterThan(0);
    });

    it('should handle invalid port numbers gracefully', async () => {
      const runtimeWithInvalidPort = createMockRuntime({
        getService: mock().mockImplementation((name: string) => {
          if (name === 'tunnel' || name === 'ngrok-tunnel') {
            return mockTunnelService;
          }
          return null;
        }),
        useModel: mock().mockResolvedValue('{"port": -1}'),
      });
      const memory = createMockMemory({
        content: { text: 'start tunnel on port -1' },
      });
      mockTunnelService.startTunnel.mockResolvedValue('https://test.ngrok.io');

      const result = await startTunnelAction.handler(
        runtimeWithInvalidPort,
        memory,
        mockState,
        {},
        mockCallback
      );

      expect(result.values?.success).toBe(true);
      expect(result.values?.tunnelUrl).toContain('ngrok.io');
      expect(mockTunnelService.startTunnel.calls.length).toBeGreaterThan(0);
    });

    it('should handle port extraction failure', async () => {
      mockMemory.content = { text: 'start tunnel' };
      mockUseModel.mockResolvedValue('invalid json');
      mockTunnelService.startTunnel.mockResolvedValue('https://test.ngrok.io');

      const result = await startTunnelAction.handler(
        mockRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      );

      expect(result.values?.success).toBe(true);
      expect(result.values?.tunnelUrl).toContain('ngrok.io');
      expect(mockTunnelService.startTunnel.calls.length).toBeGreaterThan(0);
      expect(mockTunnelService.startTunnel.calls[0][0]).toBe(3000); // Should use default
    });

    it('should handle tunnel start failure', async () => {
      // Create a fresh mock service for this test that will fail
      const failingTunnelService = new MockNgrokService({} as IAgentRuntime);
      failingTunnelService.startTunnel.mockRejectedValue(new Error('Ngrok auth failed'));
      failingTunnelService.isActive.mockReturnValue(false);

      const failingRuntime = createMockRuntime({
        getService: mock().mockImplementation((name: string) => {
          if (name === 'tunnel' || name === 'ngrok-tunnel') {
            return failingTunnelService;
          }
          return null;
        }),
        useModel: mock().mockResolvedValue('{"port": 8080}'),
      });

      mockMemory.content = { text: 'start tunnel on port 8080' };

      const result = await startTunnelAction.handler(
        failingRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      );

      expect(result.values?.success).toBe(false);
      expect(result.values?.error).toBe('Ngrok auth failed');
      expect(mockCallback.calls.length).toBeGreaterThan(0);
      const call = mockCallback.calls[0][0];
      expect(call.text).toContain('Failed to start ngrok tunnel');
      expect(call.metadata.error).toBe('Ngrok auth failed');
    });

    it('should handle port already in use', async () => {
      // Create a fresh mock service for this test that reports as active
      const activeTunnelService = new MockNgrokService({} as IAgentRuntime);
      activeTunnelService.isActive.mockReturnValue(true);
      activeTunnelService.getStatus.mockReturnValue({
        active: true,
        url: 'https://existing.ngrok.io',
        port: 8080,
        startedAt: new Date(),
        provider: 'ngrok',
      });

      const activeRuntime = createMockRuntime({
        getService: mock().mockImplementation((name: string) => {
          if (name === 'tunnel' || name === 'ngrok-tunnel') {
            return activeTunnelService;
          }
          return null;
        }),
        useModel: mock().mockResolvedValue('{"port": 8080}'),
      });

      mockMemory.content = { text: 'start tunnel on port 8080' };

      const result = await startTunnelAction.handler(
        activeRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      );

      expect(result.values?.success).toBe(false);
      expect(result.values?.error).toBe('tunnel_already_active');
      expect(mockCallback.calls.length).toBeGreaterThan(0);
      expect(mockCallback.calls[0][0].text).toContain('Tunnel is already active');
    });
  });

  describe('stopTunnelAction - Validation', () => {
    it('should validate that tunnel service exists', async () => {
      const runtimeWithoutService = createMockRuntime({
        getService: mock().mockReturnValue(null),
      });

      const isValid = await stopTunnelAction.validate(runtimeWithoutService, mockMemory);

      expect(isValid).toBe(false);
    });
  });

  describe('stopTunnelAction - Error Handling', () => {
    it('should handle service not available', async () => {
      const runtimeWithoutService = createMockRuntime({
        getService: mock().mockReturnValue(null),
      });

      const result = await stopTunnelAction.handler(
        runtimeWithoutService,
        mockMemory,
        mockState,
        {},
        mockCallback
      );

      expect(result.values?.success).toBe(false);
      expect(result.values?.error).toBe('service_unavailable');
      expect(mockCallback.calls.length).toBeGreaterThan(0);
      expect(mockCallback.calls[0][0].text).toContain('Tunnel service is not available');
    });

    it('should handle stopping when no tunnel is active', async () => {
      mockTunnelService.isActive.mockReturnValue(false);

      const result = await stopTunnelAction.handler(
        mockRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      );

      expect(result.values?.success).toBe(true);
      expect(result.values?.wasActive).toBe(false);
      expect(mockCallback.calls.length).toBeGreaterThan(0);
      expect(mockCallback.calls[0][0].text).toContain('No tunnel is currently running');
      expect(mockTunnelService.stopTunnel.calls.length).toBe(0);
    });

    it('should handle stop failure gracefully', async () => {
      // Create a fresh mock service for this test that will fail to stop
      const failingStopService = new MockNgrokService({} as IAgentRuntime);
      failingStopService.isActive.mockReturnValue(true);
      failingStopService.getStatus.mockReturnValue({
        active: true,
        url: 'https://test.ngrok.io',
        port: 8080,
        startedAt: new Date(),
        provider: 'ngrok',
      });
      failingStopService.stopTunnel.mockRejectedValue(new Error('Stop failed'));

      const failingStopRuntime = createMockRuntime({
        getService: mock().mockImplementation((name: string) => {
          if (name === 'tunnel' || name === 'ngrok-tunnel') {
            return failingStopService;
          }
          return null;
        }),
      });

      const result = await stopTunnelAction.handler(
        failingStopRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      );

      expect(result.values?.success).toBe(false);
      expect(result.values?.error).toBe('Stop failed');
      expect(mockCallback.calls.length).toBeGreaterThan(0);
      const call = mockCallback.calls[0][0];
      expect(call.text).toContain('Failed to stop ngrok tunnel');
      expect(call.metadata.error).toBe('Stop failed');
    });
  });

  describe('getTunnelStatusAction - Edge Cases', () => {
    it('should handle service not available', async () => {
      const runtimeWithoutService = createMockRuntime({
        getService: mock().mockReturnValue(null),
      });

      const result = await getTunnelStatusAction.handler(
        runtimeWithoutService,
        mockMemory,
        mockState,
        {},
        mockCallback
      );

      expect(result.values?.success).toBe(false);
      expect(result.values?.error).toBe('Tunnel service not found');
    });

    it('should format uptime correctly', async () => {
      const startTime = new Date();
      startTime.setHours(startTime.getHours() - 2); // 2 hours ago

      // Create a fresh mock service for this test with active tunnel
      const activeTunnelService = new MockNgrokService({} as IAgentRuntime);
      activeTunnelService.getStatus.mockReturnValue({
        active: true,
        url: 'https://test.ngrok.io',
        port: 8080,
        startedAt: startTime,
        provider: 'ngrok',
      });

      const activeRuntime = createMockRuntime({
        getService: mock().mockImplementation((name: string) => {
          if (name === 'tunnel' || name === 'ngrok-tunnel') {
            return activeTunnelService;
          }
          return null;
        }),
      });

      await getTunnelStatusAction.handler(activeRuntime, mockMemory, mockState, {}, mockCallback);

      expect(mockCallback.calls.length).toBeGreaterThan(0);
      expect(mockCallback.calls[0][0].text).toContain('2 hours');
    });
  });
});
