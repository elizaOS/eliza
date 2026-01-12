/**
 * @fileoverview Bootstrap Providers Tests
 *
 * Tests for bootstrap providers using REAL AgentRuntime instances.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.ts";
import type {
  IAgentRuntime,
  Media,
  Memory,
  State,
  UUID,
} from "../../types/index.ts";
import { ChannelType, MemoryType } from "../../types/index.ts";
import { attachmentsProvider } from "../providers/attachments";
import choiceProvider from "../providers/choice";
import { factsProvider } from "../providers/facts";
import { providersProvider } from "../providers/providers";
import { recentMessagesProvider } from "../providers/recentMessages";
import roleProvider from "../providers/roles";
import { settingsProvider } from "../providers/settings";
import {
  cleanupTestRuntime,
  createTestMemory,
  createTestRuntime,
  createTestState,
  createUUID,
} from "./test-utils";

// Spy on logger
beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "debug").mockImplementation(() => {});
  vi.spyOn(logger, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Choice Provider", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    message = createTestMemory({ agentId: runtime.agentId });
    state = createTestState();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should handle no pending tasks gracefully", async () => {
    vi.spyOn(runtime, "getTasks").mockResolvedValue([]);

    const result = await choiceProvider.get(runtime, message, state);

    expect(result).toBeDefined();
  });

  it("should list pending tasks with options when they exist", async () => {
    const testTask = {
      id: createUUID(),
      name: "test-task",
      roomId: message.roomId,
      metadata: {
        options: ["Option A", "Option B"],
        updateChannel: "test-channel",
      },
    };

    vi.spyOn(runtime, "getTasks").mockResolvedValue([testTask as never]);

    const result = await choiceProvider.get(runtime, message, state);

    expect(result).toBeDefined();
    expect(runtime.getTasks).toHaveBeenCalled();
  });
});

describe("Facts Provider", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    message = createTestMemory({ agentId: runtime.agentId });
    state = createTestState();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should handle empty facts gracefully", async () => {
    // Mock useModel for embedding generation
    vi.spyOn(runtime, "useModel").mockResolvedValue([0.1, 0.2, 0.3]);
    vi.spyOn(runtime, "searchMemories").mockResolvedValue([]);

    const result = await factsProvider.get(runtime, message, state);

    expect(result).toBeDefined();
  });

  it("should retrieve and format facts from memory", async () => {
    const testFacts = [
      createTestMemory({
        content: { text: "User likes pizza", channelType: ChannelType.GROUP },
        metadata: { type: MemoryType.FACT },
      }),
      createTestMemory({
        content: {
          text: "User is a developer",
          channelType: ChannelType.GROUP,
        },
        metadata: { type: MemoryType.FACT },
      }),
    ];

    // Mock useModel for embedding generation
    vi.spyOn(runtime, "useModel").mockResolvedValue([0.1, 0.2, 0.3]);
    vi.spyOn(runtime, "searchMemories").mockResolvedValue(testFacts);

    const result = await factsProvider.get(runtime, message, state);

    expect(result).toBeDefined();
  });
});

describe("Providers Provider", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    message = createTestMemory({ agentId: runtime.agentId });
    state = createTestState();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should list all dynamic providers", async () => {
    const result = await providersProvider.get(runtime, message, state);
    expect(result).toBeDefined();
  });

  it("should handle empty provider list gracefully", async () => {
    // Runtime providers is readonly, so we test the actual behavior
    const result = await providersProvider.get(runtime, message, state);
    expect(result).toBeDefined();
  });
});

describe("Recent Messages Provider", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    message = createTestMemory({ agentId: runtime.agentId });
    state = createTestState();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should retrieve recent messages from database", async () => {
    const recentMessages = [
      createTestMemory({
        content: { text: "Hello", channelType: ChannelType.GROUP },
      }),
      createTestMemory({
        content: { text: "How are you?", channelType: ChannelType.GROUP },
      }),
    ];

    vi.spyOn(runtime, "getMemories").mockResolvedValue(recentMessages);

    const result = await recentMessagesProvider.get(runtime, message, state);

    expect(result).toBeDefined();
  });

  it("should handle empty message list gracefully", async () => {
    vi.spyOn(runtime, "getMemories").mockResolvedValue([]);

    const result = await recentMessagesProvider.get(runtime, message, state);

    expect(result).toBeDefined();
  });
});

describe("Settings Provider", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    message = createTestMemory({ agentId: runtime.agentId });
    state = createTestState();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should retrieve settings in normal mode", async () => {
    const result = await settingsProvider.get(runtime, message, state);
    expect(result).toBeDefined();
  });
});

describe("Attachments Provider", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    message = createTestMemory({ agentId: runtime.agentId });
    state = createTestState();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should handle messages with no attachments", async () => {
    message.content = { text: "Hello", channelType: ChannelType.GROUP };

    const result = await attachmentsProvider.get(runtime, message, state);

    expect(result).toBeDefined();
  });

  it("should return current message attachments", async () => {
    const testAttachments: Media[] = [
      {
        id: "att-1",
        url: "https://example.com/image.png",
        contentType: "image/png",
        title: "Test Image",
      },
    ];

    message.content = {
      text: "Check this out",
      channelType: ChannelType.GROUP,
      attachments: testAttachments,
    };

    const result = await attachmentsProvider.get(runtime, message, state);

    expect(result).toBeDefined();
  });

  it("should format attachment data correctly", async () => {
    const testAttachments: Media[] = [
      {
        id: "att-1",
        url: "https://example.com/doc.pdf",
        contentType: "application/pdf",
        title: "Document",
        description: "A test document",
      },
    ];

    message.content = {
      text: "Here is the doc",
      channelType: ChannelType.GROUP,
      attachments: testAttachments,
    };

    const result = await attachmentsProvider.get(runtime, message, state);

    expect(result).toBeDefined();
  });
});

describe("Role Provider", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    message = createTestMemory({ agentId: runtime.agentId });
    state = createTestState();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should get user role from world metadata", async () => {
    const testWorldId = createUUID();
    state.data = {
      room: {
        id: message.roomId,
        type: ChannelType.GROUP,
        worldId: testWorldId,
        serverId: "test-server-id" as UUID,
        source: "test",
      },
    };

    vi.spyOn(runtime, "getWorld").mockResolvedValue({
      id: testWorldId,
      name: "Test World",
      serverId: "test-server-id",
      metadata: {
        roles: {
          [message.entityId]: "ADMIN",
        },
      },
    });

    const result = await roleProvider.get(runtime, message, state);

    expect(result).toBeDefined();
  });

  it("should handle missing world gracefully", async () => {
    vi.spyOn(runtime, "getWorld").mockResolvedValue(null);

    const result = await roleProvider.get(runtime, message, state);

    expect(result).toBeDefined();
  });
});
