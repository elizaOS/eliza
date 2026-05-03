// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import {
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type Character,
  type UUID,
  type Content,
  type Room,
  ChannelType,
} from "@elizaos/core";

const mock = vi.fn;
const spyOn = vi.spyOn;

// Re-export vitest utilities for convenience
export { describe, it, expect, mock, beforeEach, afterEach, spyOn };

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
  providers: any[];
  actions: any[];
  evaluators: any[];
  services: any[];
  getService: Mock;
};

// Create Mock Runtime
export function createMockRuntime(
  overrides: Partial<MockRuntime> = {}
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
      overrides.services?.find((s: any) => s.serviceType === name)
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
  overrides: Partial<Memory> = {}
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
  fn.mockImplementation((response: any) => {
    // Log for debugging
    console.log("Mock callback called with:", response);
  });
  return fn as any;
}

// Helper to wait for async operations
export async function waitForAsync(ms: number = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mock Service Helper
export function createMockService(serviceMethods: Record<string, any>): any {
  const service: any = {
    serviceType: "dexscreener",
    capabilityDescription: "Mock DexScreener service",
  };

  Object.entries(serviceMethods).forEach(([method, implementation]) => {
    service[method] =
      typeof implementation === "function"
        ? implementation
        : mock().mockResolvedValue(implementation);
  });

  return service;
}

// Cleanup Helper
export function cleanupMocks(...mocks: Array<ReturnType<typeof mock>>): void {
  mocks.forEach((m) => {
    if (m && typeof m.mockClear === "function") {
      m.mockClear();
    }
  });
}