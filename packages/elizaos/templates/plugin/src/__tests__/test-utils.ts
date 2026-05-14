import { randomUUID } from "node:crypto";
import {
  AgentRuntime,
  ChannelType,
  type Character,
  type Content,
  type IAgentRuntime,
  type IDatabaseAdapter,
  InMemoryDatabaseAdapter,
  type Memory,
  type MemoryMetadata,
  MemoryType,
  type Plugin,
  type Room,
  type State,
  type UUID,
} from "@elizaos/core";
import { vi } from "vitest";

export function stringToUuid(str: string): UUID {
  return str as UUID;
}

export function createUUID(): UUID {
  return stringToUuid(randomUUID());
}

export const DEFAULT_TEST_CHARACTER: Character = {
  name: "Test Agent",
  bio: ["A test agent for unit testing"],
  system: "You are a helpful assistant used for testing. Respond concisely.",
  templates: {},
  plugins: [],
  knowledge: [],
  secrets: {},
  settings: {},
  messageExamples: [],
  postExamples: [],
  topics: ["testing"],
  adjectives: ["helpful", "test"],
  style: { all: [], chat: [], post: [] },
};

export function createTestCharacter(overrides: Partial<Character> = {}): Character {
  return {
    ...DEFAULT_TEST_CHARACTER,
    id: createUUID(),
    ...overrides,
  };
}

export function createTestDatabaseAdapter(): IDatabaseAdapter {
  return new InMemoryDatabaseAdapter();
}

export async function createTestRuntime(
  options: {
    character?: Partial<Character>;
    adapter?: IDatabaseAdapter;
    plugins?: Plugin[];
    skipInitialize?: boolean;
  } = {},
): Promise<IAgentRuntime> {
  const character = createTestCharacter(options.character);
  const agentId = character.id || createUUID();
  const adapter = options.adapter || createTestDatabaseAdapter();

  const runtime = new AgentRuntime({
    agentId,
    character,
    adapter,
    enableDocuments: false,
    enableRelationships: false,
    enableTrajectories: false,
    plugins: options.plugins,
  });

  if (!options.skipInitialize) {
    await runtime.initialize();
  }

  return runtime;
}

export function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  const id = createUUID();
  return {
    id,
    roomId: overrides.roomId || ("test-room-id" as UUID),
    entityId: overrides.entityId || ("test-entity-id" as UUID),
    agentId: overrides.agentId || ("test-agent-id" as UUID),
    content: {
      text: "Test message",
      channelType: ChannelType.GROUP,
      ...overrides.content,
    } as Content,
    createdAt: Date.now(),
    metadata: { type: MemoryType.MESSAGE } as MemoryMetadata,
    ...overrides,
  };
}

export function createTestState(overrides: Partial<State> = {}): State {
  return {
    values: {
      agentName: "Test Agent",
      recentMessages: "User: Test message",
      ...overrides.values,
    },
    data: {
      room: {
        id: "test-room-id" as UUID,
        type: ChannelType.GROUP,
        worldId: "test-world-id" as UUID,
        messageServerId: "test-server-id" as UUID,
        source: "test",
      },
      ...overrides.data,
    },
    text: "",
    ...overrides,
  };
}

export function createTestRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: createUUID(),
    name: "Test Room",
    worldId: createUUID(),
    messageServerId: createUUID(),
    source: "test",
    type: ChannelType.GROUP,
    ...overrides,
  };
}

export async function setupActionTest(options?: {
  characterOverrides?: Partial<Character>;
  messageOverrides?: Partial<Memory>;
  stateOverrides?: Partial<State>;
  plugins?: Plugin[];
}): Promise<{
  runtime: IAgentRuntime;
  message: Memory;
  state: State;
  callback: ReturnType<typeof vi.fn>;
  agentId: UUID;
  roomId: UUID;
  entityId: UUID;
}> {
  const runtime = await createTestRuntime({
    character: options?.characterOverrides,
    plugins: options?.plugins,
  });

  const agentId = runtime.agentId;
  const roomId = createUUID();
  const entityId = createUUID();

  const message = createTestMemory({
    roomId,
    entityId,
    agentId,
    ...options?.messageOverrides,
  });

  const state = createTestState({
    data: {
      room: {
        id: roomId,
        type: ChannelType.GROUP,
        worldId: "test-world-id" as UUID,
        messageServerId: "test-server-id" as UUID,
        source: "test",
      },
    },
    ...options?.stateOverrides,
  });

  const callback = vi.fn().mockResolvedValue([] as Memory[]);

  return {
    runtime,
    message,
    state,
    callback,
    agentId,
    roomId,
    entityId,
  };
}

export async function cleanupTestRuntime(runtime: IAgentRuntime): Promise<void> {
  await runtime.stop();
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Condition not met within ${timeout}ms`);
}

export function setupLoggerSpies(): void {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
}

export const testFixtures = {
  agentId: "test-agent-id" as UUID,
  roomId: "test-room-id" as UUID,
  entityId: "test-entity-id" as UUID,
  worldId: "test-world-id" as UUID,
  serverId: "test-server-id" as UUID,
  userId: "test-user-id" as UUID,
  character: DEFAULT_TEST_CHARACTER,
  timestamp: Date.now(),
  messagePayload: (overrides: { content?: Partial<Content>; runtime: IAgentRuntime }) => ({
    runtime: overrides.runtime,
    message: createTestMemory(overrides.content ? { content: overrides.content as Content } : {}),
    state: createTestState(),
    source: "test",
    channel: ChannelType.GROUP,
  }),
};
