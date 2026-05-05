// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup

import {
  ChannelType,
  type Character,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type Room,
  type State,
  type UUID,
} from "@elizaos/core";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const mock = vi.fn;
const spyOn = vi.spyOn;

// Re-export vitest utilities for convenience
export { afterEach, beforeEach, describe, expect, it, mock, spyOn };

// Create a valid UUID for testing
export const testUUID = "550e8400-e29b-41d4-a716-446655440000" as UUID;

// Mock Runtime Type
export type MockRuntime = Partial<IAgentRuntime> & {
  agentId: UUID;
  character: Character;
  getSetting: Mock;
  useModel: Mock;
  composeState: Mock;
  createMemory: Mock;
  getMemories: Mock;
  searchMemories: Mock;
  updateMemory: Mock;
  getRoom: Mock;
  getParticipantUserState: Mock;
  setParticipantUserState: Mock;
  emitEvent: Mock;
  getTasks: Mock;
  providers: unknown[];
  actions: unknown[];
  evaluators: unknown[];
  services: unknown[];
  getService: Mock;
};

// Create Mock Runtime
export function createMockRuntime(
  overrides: Partial<MockRuntime> = {},
): MockRuntime {
  return {
    agentId: testUUID,
    character: {
      name: "Test Agent",
      bio: "A test agent for unit testing",
      templates: {
        messageHandlerTemplate: "Test template {{recentMessages}}",
        shouldRespondTemplate: "Should respond {{recentMessages}}",
      },
    } as Character,

    // Core methods with default implementations
    useModel: mock().mockResolvedValue("Mock response"),
    composeState: mock().mockResolvedValue({
      values: {
        agentName: "Test Agent",
        recentMessages: "Test message",
      },
      data: {
        room: {
          id: testUUID,
          type: ChannelType.DIRECT,
        },
      },
      text: "Test message",
    } as State),
    createMemory: mock().mockResolvedValue({ id: testUUID }),
    getMemories: mock().mockResolvedValue([]),
    searchMemories: mock().mockResolvedValue([]),
    updateMemory: mock().mockResolvedValue(undefined),
    getSetting: mock().mockImplementation((key: string) => {
      const settings: Record<string, string> = {
        TEST_SETTING: "test-value",
        API_KEY: "test-api-key",
        DEXSCREENER_API_URL: "https://api.dexscreener.com",
        DEXSCREENER_RATE_LIMIT_DELAY: "100",
      };
      return settings[key];
    }),
    getRoom: mock().mockResolvedValue({
      id: testUUID,
      type: ChannelType.DIRECT,
      participants: [testUUID],
    } as Room),
    getParticipantUserState: mock().mockResolvedValue(null),
    setParticipantUserState: mock().mockResolvedValue(undefined),
    emitEvent: mock().mockResolvedValue(undefined),
    getTasks: mock().mockResolvedValue([]),
    getService: mock().mockImplementation((name: string) =>
      overrides.services?.find(
        (s: unknown) =>
          typeof s === "object" &&
          s !== null &&
          "serviceType" in s &&
          (s as { serviceType?: string }).serviceType === name,
      ),
    ),
    providers: [],
    actions: [],
    evaluators: [],
    services: overrides.services || [],
    ...overrides,
  };
}

// Create Mock Memory
export function createTestMemory(
  content: string | Content,
  overrides: Partial<Memory> = {},
): Memory {
  return {
    id: testUUID,
    userId: testUUID,
    agentId: testUUID,
    roomId: testUUID,
    entityId: testUUID,
    content: typeof content === "string" ? { text: content } : content,
    createdAt: Date.now(),
    ...overrides,
  } as Memory;
}

// Create Mock State
export function createMockState(overrides: Partial<State> = {}): State {
  return {
    values: {
      agentName: "Test Agent",
      ...overrides.values,
    },
    data: {
      room: {
        id: testUUID,
        type: ChannelType.DIRECT,
      },
      ...overrides.data,
    },
    text: "Test message",
    ...overrides,
  } as State;
}

// Create Mock Handler Callback
export function createMockCallback(): HandlerCallback {
  const fn = mock();
  fn.mockImplementation((response: unknown) => {
    // Log for debugging
    console.log("Mock callback called with:", response);
  });
  return fn as HandlerCallback;
}

// Helper to wait for async operations
export async function waitForAsync(ms: number = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Method bundle for trading/search DexScreener action tests */
export type DexScreenerTradeMockMethods = {
  search: Mock;
  getTokenPairs: Mock;
  getTrending: Mock;
  getNewPairs: Mock;
  getPairsByChain: Mock;
  formatPrice: (price: string) => string;
  formatPriceChange: (change: number) => string;
  formatUsdValue: (value: number) => string;
};

/** Method bundle for boosted-token / profile coverage tests */
export type DexScreenerBoostMockMethods = {
  getTopBoostedTokens: Mock;
  getLatestBoostedTokens: Mock;
  getLatestTokenProfiles: Mock;
  formatPrice: (price: string) => string;
  formatPriceChange: (change: number) => string;
  formatUsdValue: (value: number) => string;
};

export type DexScreenerTradeMockService = {
  serviceType: string;
  capabilityDescription: string;
} & DexScreenerTradeMockMethods;

export type DexScreenerBoostMockService = {
  serviceType: string;
  capabilityDescription: string;
} & DexScreenerBoostMockMethods;

/** Trading + boosted-token mocks used by full-coverage tests */
export type DexScreenerFullMockMethods = DexScreenerTradeMockMethods & {
  getTopBoostedTokens: Mock;
  getLatestBoostedTokens: Mock;
  getLatestTokenProfiles: Mock;
};

export type DexScreenerFullMockService = {
  serviceType: string;
  capabilityDescription: string;
} & DexScreenerFullMockMethods;

// Mock Service Helper
export function createMockService<M extends Record<string, unknown>>(
  serviceMethods: M,
): { serviceType: string; capabilityDescription: string } & M {
  const service: Record<string, unknown> = {
    serviceType: "dexscreener",
    capabilityDescription: "Mock DexScreener service",
  };

  Object.entries(serviceMethods).forEach(([method, implementation]) => {
    service[method] =
      typeof implementation === "function"
        ? implementation
        : mock().mockResolvedValue(implementation);
  });

  return service as { serviceType: string; capabilityDescription: string } & M;
}

// Cleanup Helper
export function cleanupMocks(...mocks: Array<ReturnType<typeof mock>>): void {
  mocks.forEach((m) => {
    if (m && typeof m.mockClear === "function") {
      m.mockClear();
    }
  });
}
