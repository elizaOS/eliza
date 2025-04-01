import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FarcasterPostManager } from '../src/managers/post';

// Mock core dependencies at the top level
vi.mock('@elizaos/core', () => {
  return {
    EventType: {
      POST_GENERATED: 'post_generated',
    },
    logger: {
      info: vi.fn(),
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
    },
    createUniqueUuid: vi.fn().mockImplementation((runtime, id) => `uuid-${id}`),
  };
});

// Mock other dependencies
vi.mock('../src/common/types', () => {
  return {
    FarcasterEventTypes: {
      POST_GENERATED: 'farcaster:post_generated',
    },
  };
});

vi.mock('../src/common/callbacks', () => {
  return {
    standardCastHandlerCallback: vi.fn().mockImplementation(() => () => {}),
  };
});

vi.mock('../src/common/constants', () => {
  return {
    FARCASTER_SOURCE: 'farcaster',
  };
});

vi.mock('../src/common/utils', () => {
  return {
    lastCastCacheKey: vi.fn().mockImplementation((fid) => `lastCast-${fid}`),
  };
});

// Tests focus on the public API
describe('FarcasterPostManager', () => {
  let manager;
  let mockClient;
  let mockRuntime;
  let mockConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      sendCast: vi.fn().mockResolvedValue([]),
    };

    mockRuntime = {
      agentId: 'test-agent',
      getCache: vi.fn().mockResolvedValue(null),
      setCache: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
    };

    mockConfig = {
      FARCASTER_FID: 123,
      ENABLE_POST: true,
      POST_IMMEDIATELY: false,
      POST_INTERVAL_MIN: 60,
      POST_INTERVAL_MAX: 120,
      FARCASTER_DRY_RUN: false,
    };

    manager = new FarcasterPostManager({
      client: mockClient,
      runtime: mockRuntime,
      config: mockConfig,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with correct properties', () => {
    expect(manager.client).toBe(mockClient);
    expect(manager.runtime).toBe(mockRuntime);
    expect(manager.fid).toBe(123);
  });

  it('should not start posting if ENABLE_POST is false', async () => {
    mockConfig.ENABLE_POST = false;

    await manager.start();

    // Should not emit any events if disabled
    expect(mockRuntime.emitEvent).not.toHaveBeenCalled();
  });

  it('should clear timeout on stop', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    // Set a mock timeout
    const mockTimeout = setTimeout(() => {}, 1000);

    // We need to directly set the private timeout property
    // @ts-ignore - directly setting private property for testing
    manager.timeout = mockTimeout;

    // Call stop
    await manager.stop();

    // Should clear the timeout
    expect(clearTimeoutSpy).toHaveBeenCalledWith(mockTimeout);
  });

  it('should post immediately if POST_IMMEDIATELY is true', async () => {
    mockConfig.POST_IMMEDIATELY = true;

    // Start the manager
    await manager.start();

    // Should have emitted an event immediately
    expect(mockRuntime.emitEvent).toHaveBeenCalled();
    expect(mockRuntime.emitEvent.mock.calls[0][0]).toEqual([
      'post_generated',
      'farcaster:post_generated',
    ]);

    // Should include necessary data
    const eventData = mockRuntime.emitEvent.mock.calls[0][1];
    expect(eventData).toHaveProperty('runtime', mockRuntime);
    expect(eventData).toHaveProperty('worldId');
    expect(eventData).toHaveProperty('userId', 'test-agent');
    expect(eventData).toHaveProperty('callback');
  });
});
