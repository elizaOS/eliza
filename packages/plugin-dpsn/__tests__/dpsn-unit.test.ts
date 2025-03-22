import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DpsnService } from '../src';

describe('DPSN Unit Tests', () => {
  let dpsnService: DpsnService;
  let mockRuntime: any;
  let mockDpsnClient: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockDpsnClient = {
      init: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn(),
      subscribe: vi.fn(),
    };

    // Create a mock runtime
    mockRuntime = {
      getSetting: vi.fn((key: string) => {
        if (key === 'DPSN_URL') return 'betanet.dpsn.org';
        if (key === 'DPSN_WALLET_PVT_KEY') return 'mock-private-key';
        return undefined;
      }),
      getService: vi.fn((name: string) => {
        if (name === 'dpsn') return dpsnService;
        return null;
      }),
    };

    dpsnService = new DpsnService(mockRuntime);
    dpsnService['dpsnClient'] = mockDpsnClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize the DPSN service', async () => {
    // Create a new mock runtime for this test
    const testRuntime = {
      getSetting: vi.fn((key: string) => {
        if (key === 'DPSN_URL') return 'betanet.dpsn.org';
        if (key === 'DPSN_WALLET_PVT_KEY') return 'mock-private-key';
        return undefined;
      }),
      getService: vi.fn(),
      agentId: 'test-agent',
      character: {},
      providers: {},
      actions: {},
      services: {},
      events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    } as any;

    // Spy on the initializeDpsnClient method
    const originalMethod = DpsnService.prototype['initializeDpsnClient'];
    DpsnService.prototype['initializeDpsnClient'] = vi.fn();

    // Start the service
    await DpsnService.start(testRuntime);

    // Check if initializeDpsnClient was called with correct parameters
    expect(DpsnService.prototype['initializeDpsnClient']).toHaveBeenCalledWith(
      'betanet.dpsn.org',
      'mock-private-key'
    );

    // Restore the original method
    DpsnService.prototype['initializeDpsnClient'] = originalMethod;
  });

  it('should stop the DPSN service', async () => {
    // Stop the service
    await dpsnService.stop();

    // Check if disconnect was called
    expect(mockDpsnClient.disconnect).toHaveBeenCalled();
  });

  it('should register connect event handler', async () => {
    // Mock callback
    const mockCallback = vi.fn();

    // Register connect event handler
    dpsnService.on('connect', mockCallback);

    // Check if on was called with the event type and callback
    expect(mockDpsnClient.on).toHaveBeenCalledWith('connect', mockCallback);
  });

  it('should register error event handler', async () => {
    // Mock callback
    const mockCallback = vi.fn();

    // Register error event handler
    dpsnService.on('error', mockCallback);

    // Check if on was called with the event type and callback
    expect(mockDpsnClient.on).toHaveBeenCalledWith('error', mockCallback);
  });

  it('should subscribe to a topic', async () => {
    // Mock callback
    const mockCallback = vi.fn();

    dpsnService.subscribe('test-topic', mockCallback);

    expect(mockDpsnClient.subscribe).toHaveBeenCalledWith('test-topic', expect.any(Function));
  });

  it('should subscribe to a topic with subtopic', async () => {
    // Mock callback
    const mockCallback = vi.fn();

    // Subscribe to a topic with subtopic
    dpsnService.subscribe('test-topic', mockCallback, 'subtopic');

    // Check if subscribe was called with the full topic and a callback
    expect(mockDpsnClient.subscribe).toHaveBeenCalledWith(
      'test-topic/subtopic',
      expect.any(Function)
    );
  });

  it('should call static stop method', async () => {
    const stopSpy = vi.spyOn(dpsnService, 'stop');
    await DpsnService.stop(mockRuntime);

    expect(stopSpy).toHaveBeenCalled();
  });

  it('should get the DPSN client', () => {
    const client = dpsnService.getDpsnClient();
    expect(client).toBe(mockDpsnClient);
  });
});
