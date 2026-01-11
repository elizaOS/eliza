// TODO: Try-catch review completed 2026-01-11. All try-catch blocks retained:
// - beforeAll plugin-sql import - KEEP (conditional test execution)

/**
 * @fileoverview Bootstrap Providers Tests
 *
 * Tests for bootstrap providers using REAL AgentRuntime instances.
 * No mocks - all tests run against actual runtime infrastructure with PGLite.
 */

import {
  ChannelType,
  type IAgentRuntime,
  type IDatabaseAdapter,
  logger,
  type Media,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentsProvider } from "../providers/attachments";
import choiceProvider from "../providers/choice";
import { factsProvider } from "../providers/facts";
import { providersProvider } from "../providers/providers";
import { recentMessagesProvider } from "../providers/recentMessages";
import roleProvider from "../providers/roles";
import { settingsProvider } from "../providers/settings";
import { createTestMemory, createTestState, createUUID } from "./test-utils";

// Import the real runtime and database adapter
import { AgentRuntime } from "../../runtime";

// We need a database adapter for tests - use PGLite
let sqlPlugin: { createDatabaseAdapter: (config: { dataDir: string }, agentId: UUID) => IDatabaseAdapter };

beforeAll(async () => {
  try {
    sqlPlugin = await import("@elizaos/plugin-sql");
  } catch {
    console.warn("@elizaos/plugin-sql not available, skipping provider tests");
  }
});

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

/**
 * Helper to create a real test runtime with PGLite database
 */
async function createTestRuntime(): Promise<{ runtime: IAgentRuntime; cleanup: () => Promise<void> }> {
  if (!sqlPlugin) {
    throw new Error("@elizaos/plugin-sql is required for these tests");
  }

  const agentId = createUUID();
  const adapter = sqlPlugin.createDatabaseAdapter({ dataDir: ":memory:" }, agentId);
  await adapter.init();

  const runtime = new AgentRuntime({
    agentId,
    character: {
      name: "Test Agent",
      bio: "A test agent for provider tests",
      system: "You are a helpful test assistant.",
      plugins: [],
      settings: {},
    },
    adapter,
  });

  await runtime.initialize();

  return {
    runtime,
    cleanup: async () => {
      await runtime.stop();
      await adapter.close();
    },
  };
}

describe("Choice Provider", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testRoomId: UUID;

  beforeEach(async () => {
    if (!sqlPlugin) {
      return;
    }
    const result = await createTestRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;

    testRoomId = createUUID();

    await runtime.ensureRoomExists({
      id: testRoomId,
      name: "Test Room",
      source: "test",
      type: ChannelType.GROUP,
    });
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("should handle no pending tasks gracefully", async () => {
    if (!sqlPlugin) {
      console.warn("Skipping test - plugin-sql not available");
      return;
    }

    const testMessage = createTestMemory({ roomId: testRoomId });
    const testState = createTestState();

    const result = await choiceProvider.get(runtime, testMessage, testState);

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data?.tasks).toHaveLength(0);
    expect(result.text).toContain("No pending choices for the moment.");
  });

  it("should list pending tasks with options when they exist", async () => {
    if (!sqlPlugin) {
      console.warn("Skipping test - plugin-sql not available");
      return;
    }

    // Create a task with options
    await runtime.createTask({
      name: "Approve Post",
      description: "A blog post is awaiting approval.",
      roomId: testRoomId,
      tags: ["AWAITING_CHOICE"],
      metadata: {
        options: [
          "approve",
          "reject",
          { name: "edit", description: "Edit the post" },
        ],
      },
    });

    const testMessage = createTestMemory({ roomId: testRoomId });
    const testState = createTestState();

    const result = await choiceProvider.get(runtime, testMessage, testState);

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data?.tasks).toHaveLength(1);
    expect(result.text).toContain("Pending Tasks");
  });
});

describe("Facts Provider", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testRoomId: UUID;
  let testEntityId: UUID;

  beforeEach(async () => {
    if (!sqlPlugin) {
      return;
    }
    const result = await createTestRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;

    testRoomId = createUUID();
    testEntityId = createUUID();

    await runtime.ensureRoomExists({
      id: testRoomId,
      name: "Test Room",
      source: "test",
      type: ChannelType.GROUP,
    });

    await runtime.ensureConnection({
      entityId: testEntityId,
      roomId: testRoomId,
      userName: "Test User",
      name: "Test User",
      source: "test",
    });
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("should handle empty facts gracefully", async () => {
    if (!sqlPlugin) {
      console.warn("Skipping test - plugin-sql not available");
      return;
    }

    const testMessage = createTestMemory({
      roomId: testRoomId,
      entityId: testEntityId,
      agentId: runtime.agentId,
    });
    const testState = createTestState();

    const result = await factsProvider.get(runtime, testMessage, testState);

    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
  });
});

describe("Providers Provider", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testRoomId: UUID;

  beforeEach(async () => {
    if (!sqlPlugin) {
      return;
    }
    const result = await createTestRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;

    testRoomId = createUUID();

    await runtime.ensureRoomExists({
      id: testRoomId,
      name: "Test Room",
      source: "test",
      type: ChannelType.GROUP,
    });

    // Register some test providers
    runtime.registerProvider({
      name: "TEST_PROVIDER_1",
      description: "Test provider 1",
      dynamic: true,
      get: async () => ({ text: "test1", data: {}, values: {} }),
    });

    runtime.registerProvider({
      name: "TEST_PROVIDER_2",
      description: "Test provider 2",
      dynamic: true,
      get: async () => ({ text: "test2", data: {}, values: {} }),
    });

    runtime.registerProvider({
      name: "INTERNAL_PROVIDER",
      description: "Internal provider",
      dynamic: false,
      get: async () => ({ text: "internal", data: {}, values: {} }),
    });
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("should list all dynamic providers", async () => {
    if (!sqlPlugin) {
      console.warn("Skipping test - plugin-sql not available");
      return;
    }

    const testMessage = createTestMemory({ roomId: testRoomId });
    const testState = createTestState();

    const result = await providersProvider.get(runtime, testMessage, testState);

    expect(result).toBeDefined();
    expect(result.text).toContain("TEST_PROVIDER_1");
    expect(result.text).toContain("TEST_PROVIDER_2");
    // Internal providers (dynamic: false) should not be listed
    expect(result.text).not.toContain("INTERNAL_PROVIDER");

    expect(result.data).toBeDefined();
    expect(result.data?.dynamicProviders).toBeDefined();
  });

  it("should handle empty provider list gracefully", async () => {
    if (!sqlPlugin) {
      console.warn("Skipping test - plugin-sql not available");
      return;
    }

    // Clear all providers
    runtime.providers = [];

    const testMessage = createTestMemory({ roomId: testRoomId });
    const testState = createTestState();

    const result = await providersProvider.get(runtime, testMessage, testState);

    expect(result).toBeDefined();
    expect(result.text).toContain("No dynamic providers are currently available");
    expect(result.data?.dynamicProviders).toHaveLength(0);
  });
});

describe("Recent Messages Provider", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testRoomId: UUID;
  let testEntityId: UUID;

  beforeEach(async () => {
    if (!sqlPlugin) {
      return;
    }
    const result = await createTestRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;

    testRoomId = createUUID();
    testEntityId = createUUID();

    await runtime.ensureRoomExists({
      id: testRoomId,
      name: "Test Room",
      source: "test",
      type: ChannelType.GROUP,
    });

    await runtime.ensureConnection({
      entityId: testEntityId,
      roomId: testRoomId,
      userName: "Test User",
      name: "Test User",
      source: "test",
    });
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("should retrieve recent messages from database", async () => {
    if (!sqlPlugin) {
      console.warn("Skipping test - plugin-sql not available");
      return;
    }

    // Create some test messages in the database
    await runtime.createMemory({
      roomId: testRoomId,
      entityId: testEntityId,
      agentId: runtime.agentId,
      content: { text: "Hello there!", channelType: ChannelType.GROUP },
    }, "messages");

    await runtime.createMemory({
      roomId: testRoomId,
      entityId: testEntityId,
      agentId: runtime.agentId,
      content: { text: "How are you?", channelType: ChannelType.GROUP },
    }, "messages");

    const testMessage = createTestMemory({
      roomId: testRoomId,
      entityId: testEntityId,
      agentId: runtime.agentId,
      content: { text: "Current message", channelType: ChannelType.GROUP },
    });
    const testState = createTestState();

    const result = await recentMessagesProvider.get(runtime, testMessage, testState);

    expect(result).toBeDefined();
    expect(result.text).toContain("Hello there!");
    expect(result.text).toContain("How are you?");
  });

  it("should handle empty message list gracefully", async () => {
    if (!sqlPlugin) {
      console.warn("Skipping test - plugin-sql not available");
      return;
    }

    const testMessage = createTestMemory({
      roomId: testRoomId,
      entityId: testEntityId,
      content: { text: "", channelType: ChannelType.GROUP },
    });
    const testState = createTestState();

    const result = await recentMessagesProvider.get(runtime, testMessage, testState);

    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
  });
});

describe("Settings Provider", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testRoomId: UUID;
  let testWorldId: UUID;

  beforeEach(async () => {
    if (!sqlPlugin) {
      return;
    }
    const result = await createTestRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;

    testRoomId = createUUID();
    testWorldId = createUUID();

    await runtime.ensureWorldExists({
      id: testWorldId,
      name: "Test World",
      messageServerId: "test-server",
    });

    await runtime.ensureRoomExists({
      id: testRoomId,
      name: "Test Room",
      source: "test",
      type: ChannelType.GROUP,
      worldId: testWorldId,
    });
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("should retrieve settings in normal mode", async () => {
    if (!sqlPlugin) {
      console.warn("Skipping test - plugin-sql not available");
      return;
    }

    const testMessage = createTestMemory({
      roomId: testRoomId,
      content: { channelType: ChannelType.GROUP },
    });
    const testState = createTestState({
      data: {
        room: {
          id: testRoomId,
          worldId: testWorldId,
          type: ChannelType.GROUP,
        },
      },
    });

    const result = await settingsProvider.get(runtime, testMessage, testState);

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.text).toBeDefined();
  });
});

describe("Attachments Provider", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testRoomId: UUID;

  beforeEach(async () => {
    if (!sqlPlugin) {
      return;
    }
    const result = await createTestRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;

    testRoomId = createUUID();

    await runtime.ensureRoomExists({
      id: testRoomId,
      name: "Test Room",
      source: "test",
      type: ChannelType.GROUP,
    });
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("should handle messages with no attachments", async () => {
    if (!sqlPlugin) {
      console.warn("Skipping test - plugin-sql not available");
      return;
    }

    const testMessage = createTestMemory({
      roomId: testRoomId,
      content: {
        text: "Hello, how are you?",
        channelType: ChannelType.GROUP,
      },
    });
    const testState = createTestState();

    const result = await attachmentsProvider.get(runtime, testMessage, testState);

    expect(result).toBeDefined();
    expect(result.data?.attachments).toHaveLength(0);
    expect(result.text).toBe("");
    expect(result.values?.attachments).toBe("");
  });

  it("should return current message attachments", async () => {
    if (!sqlPlugin) {
      console.warn("Skipping test - plugin-sql not available");
      return;
    }

    const testAttachments: Media[] = [
      {
        id: "attach-1",
        url: "https://example.com/image1.jpg",
        title: "Test Image 1",
        source: "image/jpeg",
        description: "A test image",
        text: "Image content text",
      },
    ];

    const testMessage = createTestMemory({
      roomId: testRoomId,
      content: {
        text: "Check out this attachment",
        channelType: ChannelType.GROUP,
        attachments: testAttachments,
      },
    });
    const testState = createTestState();

    const result = await attachmentsProvider.get(runtime, testMessage, testState);

    expect(result).toBeDefined();
    expect(result.data?.attachments).toHaveLength(1);
    expect(result.data?.attachments?.[0]?.id).toBe("attach-1");
    expect(result.text).toContain("# Attachments");
    expect(result.text).toContain("Test Image 1");
    expect(result.text).toContain("https://example.com/image1.jpg");
  });

  it("should format attachment data correctly", async () => {
    if (!sqlPlugin) {
      console.warn("Skipping test - plugin-sql not available");
      return;
    }

    const testAttachment: Media = {
      id: "format-test",
      url: "https://example.com/test.png",
      title: "Format Test Image",
      source: "image/png",
      description: "Testing formatted output",
      text: "This is the extracted text from the image",
    };

    const testMessage = createTestMemory({
      roomId: testRoomId,
      content: {
        text: "Testing format",
        channelType: ChannelType.GROUP,
        attachments: [testAttachment],
      },
    });
    const testState = createTestState();

    const result = await attachmentsProvider.get(runtime, testMessage, testState);

    expect(result).toBeDefined();
    expect(result.text).toContain("# Attachments");
    expect(result.text).toContain("ID: format-test");
    expect(result.text).toContain("Name: Format Test Image");
    expect(result.text).toContain("URL: https://example.com/test.png");
    expect(result.text).toContain("Type: image/png");
    expect(result.text).toContain("Description: Testing formatted output");
    expect(result.text).toContain("Text: This is the extracted text from the image");
  });
});
