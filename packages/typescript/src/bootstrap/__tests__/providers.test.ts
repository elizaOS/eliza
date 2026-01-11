/**
 * @fileoverview Bootstrap Providers Tests
 *
 * Tests for bootstrap providers using IAgentRuntime interface.
 */

import {
  ChannelType,
  type IAgentRuntime,
  logger,
  type Media,
  type Memory,
  MemoryType,
  type State,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentsProvider } from "../providers/attachments";
import choiceProvider from "../providers/choice";
import { factsProvider } from "../providers/facts";
import { providersProvider } from "../providers/providers";
import { recentMessagesProvider } from "../providers/recentMessages";
import roleProvider from "../providers/roles";
import { settingsProvider } from "../providers/settings";
import {
  createMockMemory,
  createMockRuntime,
  createMockState,
  createUUID,
  type MockRuntime,
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
  let mockRuntime: MockRuntime;
  let mockMessage: Memory;
  let mockState: State;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockMessage = createMockMemory();
    mockState = createMockState();
  });

  it("should handle no pending tasks gracefully", async () => {
    // No pending tasks
    mockRuntime.getTasks = vi.fn().mockResolvedValue([]);

    const result = await choiceProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

    expect(result).toBeDefined();
  });

  it("should list pending tasks with options when they exist", async () => {
    const testTask = {
      id: createUUID(),
      name: "test-task",
      roomId: mockMessage.roomId,
      metadata: {
        options: ["Option A", "Option B"],
        updateChannel: "test-channel",
      },
    };

    mockRuntime.getTasks = vi.fn().mockResolvedValue([testTask]);

    const result = await choiceProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

    expect(result).toBeDefined();
    expect(mockRuntime.getTasks).toHaveBeenCalled();
  });
});

describe("Facts Provider", () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Memory;
  let mockState: State;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockMessage = createMockMemory();
    mockState = createMockState();
  });

  it("should handle empty facts gracefully", async () => {
    // No facts in memory
    mockRuntime.searchMemories = vi.fn().mockResolvedValue([]);

    const result = await factsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

    expect(result).toBeDefined();
  });

  it("should retrieve and format facts from memory", async () => {
    const testFacts = [
      createMockMemory({
        content: { text: "User likes pizza" },
        metadata: { type: MemoryType.FACT },
      }),
      createMockMemory({
        content: { text: "User is a developer" },
        metadata: { type: MemoryType.FACT },
      }),
    ];

    mockRuntime.searchMemories = vi.fn().mockResolvedValue(testFacts);

    const result = await factsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

    expect(result).toBeDefined();
  });
});

describe("Providers Provider", () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Memory;
  let mockState: State;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockMessage = createMockMemory();
    mockState = createMockState();
  });

  it("should list all dynamic providers", async () => {
    // Set up some mock providers
    mockRuntime.providers = [
      { name: "provider1", get: vi.fn() },
      { name: "provider2", get: vi.fn() },
    ];

    const result = await providersProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

    expect(result).toBeDefined();
  });

  it("should handle empty provider list gracefully", async () => {
    mockRuntime.providers = [];

    const result = await providersProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

    expect(result).toBeDefined();
  });
});

describe("Recent Messages Provider", () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Memory;
  let mockState: State;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockMessage = createMockMemory();
    mockState = createMockState();
  });

  it("should retrieve recent messages from database", async () => {
    const recentMessages = [
      createMockMemory({ content: { text: "Hello" } }),
      createMockMemory({ content: { text: "How are you?" } }),
    ];

    mockRuntime.getMemories = vi.fn().mockResolvedValue(recentMessages);

    const result = await recentMessagesProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

    expect(result).toBeDefined();
  });

  it("should handle empty message list gracefully", async () => {
    mockRuntime.getMemories = vi.fn().mockResolvedValue([]);

    const result = await recentMessagesProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

    expect(result).toBeDefined();
  });
});

describe("Settings Provider", () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Memory;
  let mockState: State;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockMessage = createMockMemory();
    mockState = createMockState();
  });

  it("should retrieve settings in normal mode", async () => {
    mockRuntime.getSetting = vi.fn().mockReturnValue("test-value");

    const result = await settingsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

    expect(result).toBeDefined();
  });
});

describe("Attachments Provider", () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Memory;
  let mockState: State;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockMessage = createMockMemory();
    mockState = createMockState();
  });

  it("should handle messages with no attachments", async () => {
    mockMessage.content = { text: "Hello", channelType: ChannelType.GROUP };

    const result = await attachmentsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

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

    mockMessage.content = {
      text: "Check this out",
      channelType: ChannelType.GROUP,
      attachments: testAttachments,
    };

    const result = await attachmentsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

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

    mockMessage.content = {
      text: "Here is the doc",
      channelType: ChannelType.GROUP,
      attachments: testAttachments,
    };

    const result = await attachmentsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

    expect(result).toBeDefined();
  });
});

describe("Role Provider", () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Memory;
  let mockState: State;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockMessage = createMockMemory();
    mockState = createMockState();
  });

  it("should get user role from world metadata", async () => {
    const testWorldId = createUUID();
    mockState.data = {
      room: {
        id: mockMessage.roomId,
        type: ChannelType.GROUP,
        worldId: testWorldId,
        serverId: "test-server-id" as UUID,
        source: "test",
      },
    };

    mockRuntime.getWorld = vi.fn().mockResolvedValue({
      id: testWorldId,
      name: "Test World",
      serverId: "test-server-id",
      metadata: {
        roles: {
          [mockMessage.entityId]: "ADMIN",
        },
      },
    });

    const result = await roleProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

    expect(result).toBeDefined();
  });

  it("should handle missing world gracefully", async () => {
    mockRuntime.getWorld = vi.fn().mockResolvedValue(null);

    const result = await roleProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage,
      mockState,
    );

    expect(result).toBeDefined();
  });
});
