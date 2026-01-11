import {
  type ActionEventPayload,
  ChannelType,
  type Content,
  type EntityPayload,
  type EvaluatorEventPayload,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type MessagePayload,
  ModelType,
  type UUID,
} from "@elizaos/core";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBootstrapPlugin } from "../index";
import { type MockRuntime, setupActionTest } from "./test-utils";

// Create the bootstrap plugin for testing
const bootstrapPlugin = createBootstrapPlugin();

describe("Message Handler Logic", () => {
  let mockRuntime: MockRuntime;
  let _mockMessage: Partial<Memory>;
  let _mockCallback: HandlerCallback;

  beforeEach(() => {

    // Use shared setupActionTest instead of manually creating mocks
    const setup = setupActionTest({
      runtimeOverrides: {
        // Override default runtime methods for testing message handlers
        useModel: vi.fn().mockImplementation((modelType, params) => {
          const paramsPrompt = params?.prompt;
          if (
            paramsPrompt &&
            typeof paramsPrompt === "string" &&
            paramsPrompt.includes("should respond template")
          ) {
            return Promise.resolve(
              JSON.stringify({
                action: "RESPOND",
                providers: ["facts", "time"],
                reasoning: "Message requires a response",
              }),
            );
          } else if (modelType === ModelType.TEXT_SMALL) {
            return Promise.resolve(
              JSON.stringify({
                thought: "I will respond to this message",
                actions: ["reply"],
                content: "Hello, how can I help you today?",
              }),
            );
          } else if (modelType === ModelType.TEXT_EMBEDDING) {
            return Promise.resolve([0.1, 0.2, 0.3]);
          }
          return Promise.resolve({});
        }),

        composeState: vi.fn().mockResolvedValue({
          values: {
            agentName: "Test Agent",
            recentMessages: "User: Test message",
          },
          data: {
            room: { id: "test-room-id", type: ChannelType.GROUP },
          },
        }),

        getRoom: vi.fn().mockResolvedValue({
          id: "test-room-id",
          name: "Test Room",
          type: ChannelType.GROUP,
          worldId: "test-world-id",
          messageServerId: "test-server-id",
          source: "test",
        }),

        getParticipantUserState: vi.fn().mockResolvedValue("ACTIVE"),
      },
      messageOverrides: {
        content: {
          text: "Hello, bot!",
          channelType: ChannelType.GROUP,
        } as Content,
      },
    });

    mockRuntime = setup.mockRuntime;
    _mockMessage = setup.mockMessage;
    _mockCallback = setup.callbackFn as HandlerCallback;

    // Add required templates to character
    mockRuntime.character = {
      ...mockRuntime.character,
      templates: {
        ...mockRuntime.character.templates,
        messageHandlerTemplate:
          "Test message handler template {{recentMessages}}",
        shouldRespondTemplate:
          "Test should respond template {{recentMessages}}",
      },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should register all expected event handlers", () => {
    // Verify bootstrap plugin has event handlers
    expect(bootstrapPlugin.events).toBeDefined();

    // Check for mandatory event handlers
    // Removed events now handled directly via runtime.messageService:
    // - MESSAGE_RECEIVED -> deprecated (kept for logging only)
    // - VOICE_MESSAGE_RECEIVED -> runtime.messageService.handleMessage()
    // - MESSAGE_DELETED -> runtime.messageService.deleteMessage()
    // - CHANNEL_CLEARED -> runtime.messageService.clearChannel()
    const requiredEvents = [
      EventType.REACTION_RECEIVED,
      EventType.MESSAGE_SENT,
      EventType.WORLD_JOINED,
      EventType.ENTITY_JOINED,
      EventType.ENTITY_LEFT,
    ];

    requiredEvents.forEach((eventType) => {
      const bootstrapPluginEvents = bootstrapPlugin.events;
      const bootstrapPluginEventsForType = bootstrapPluginEvents?.[eventType];
      expect(bootstrapPluginEventsForType).toBeDefined();
      expect(bootstrapPluginEventsForType?.length).toBeGreaterThan(0);
    });
  });

  // MESSAGE_RECEIVED handler is deprecated - actual handling via runtime.messageService
  // Tests for message handling are now in packages/typescript/src/__tests__/message-service.test.ts
});

describe("Reaction Events", () => {
  let mockRuntime: MockRuntime;
  let mockReaction: Partial<Memory>;

  beforeEach(() => {
    // Use setupActionTest for consistent test setup
    const setup = setupActionTest({
      messageOverrides: {
        content: {
          text: "👍",
          reaction: true,
          referencedMessageId: "original-message-id",
        } as Content,
      },
    });

    mockRuntime = setup.mockRuntime;
    mockReaction = setup.mockMessage;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should store reaction messages correctly", async () => {
    // Get the REACTION_RECEIVED handler
    const bootstrapPluginEvents = bootstrapPlugin.events;
    const bootstrapPluginEventsReaction =
      bootstrapPluginEvents?.[EventType.REACTION_RECEIVED];
    const reactionHandler = bootstrapPluginEventsReaction?.[0];
    expect(reactionHandler).toBeDefined();

    if (reactionHandler) {
      // Call the handler with our mock payload
      await reactionHandler({
        runtime: mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
        message: mockReaction as Memory,
        source: "test",
      } as MessagePayload);

      // Verify reaction was stored
      expect(mockRuntime.createMemory).toHaveBeenCalledWith(
        mockReaction,
        "messages",
      );
    }
  });

  it("should handle duplicate reaction errors", async () => {
    // Get the REACTION_RECEIVED handler
    const bootstrapPluginEvents = bootstrapPlugin.events;
    const bootstrapPluginEventsReaction =
      bootstrapPluginEvents?.[EventType.REACTION_RECEIVED];
    const reactionHandler = bootstrapPluginEventsReaction?.[0];
    expect(reactionHandler).toBeDefined();

    // Simulate a duplicate key error
    mockRuntime.createMemory = vi.fn().mockRejectedValue({ code: "23505" });

    if (reactionHandler) {
      // Should not throw when handling duplicate error
      let error: Error | undefined;
      try {
        await reactionHandler({
          runtime: mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
          message: mockReaction as Memory,
          source: "test",
        } as MessagePayload);
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeUndefined();
    }
  });
});

describe("World and Entity Events", () => {
  let mockRuntime: MockRuntime;

  beforeEach(() => {
    // Use setupActionTest for consistent test setup
    const setup = setupActionTest({
      runtimeOverrides: {
        ensureConnection: vi.fn().mockResolvedValue(undefined),
        ensureWorldExists: vi.fn().mockResolvedValue(undefined),
        ensureRoomExists: vi.fn().mockResolvedValue(undefined),
        getEntityById: vi.fn().mockImplementation((entityId) => {
          return Promise.resolve({
            id: entityId,
            names: ["Test User"],
            metadata: {
              status: "ACTIVE",
              // Add source-specific metadata to fix the test
              test: {
                username: "testuser",
                name: "Test User",
                userId: "original-id-123",
              },
            },
          });
        }),
        updateEntity: vi.fn().mockResolvedValue(undefined),
      },
    });

    mockRuntime = setup.mockRuntime;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should handle ENTITY_JOINED events", async () => {
    // Get the ENTITY_JOINED handler
    const bootstrapPluginEvents = bootstrapPlugin.events;
    const bootstrapPluginEventsEntityJoined =
      bootstrapPluginEvents?.[EventType.ENTITY_JOINED];
    const entityJoinedHandler = bootstrapPluginEventsEntityJoined?.[0];
    expect(entityJoinedHandler).toBeDefined();

    if (entityJoinedHandler) {
      // Call the handler with our mock payload
      await entityJoinedHandler({
        runtime: mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
        entityId: "test-entity-id" as UUID,
        worldId: "test-world-id" as UUID,
        roomId: "test-room-id" as UUID,
        metadata: {
          type: "user",
          originalId: "original-id-123",
          username: "testuser",
          displayName: "Test User",
          avatarUrl: "https://example.com/avatar.png",
        },
        source: "test",
      } as EntityPayload);

      // Verify entity was processed
      expect(mockRuntime.ensureConnection).toHaveBeenCalled();
    }
  });

  it("should handle ENTITY_LEFT events", async () => {
    // Get the ENTITY_LEFT handler
    const bootstrapPluginEvents = bootstrapPlugin.events;
    const bootstrapPluginEventsEntityLeft =
      bootstrapPluginEvents?.[EventType.ENTITY_LEFT];
    const entityLeftHandler = bootstrapPluginEventsEntityLeft?.[0];
    expect(entityLeftHandler).toBeDefined();

    if (entityLeftHandler) {
      // Call the handler with our mock payload
      await entityLeftHandler({
        runtime: mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
        entityId: "test-entity-id" as UUID,
        worldId: "test-world-id" as UUID,
        source: "test",
      } as EntityPayload);

      // Verify entity was updated
      expect(mockRuntime.getEntityById).toHaveBeenCalledWith("test-entity-id");
      expect(mockRuntime.updateEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            status: "INACTIVE",
            leftAt: expect.any(Number),
          }),
        }),
      );
    }
  });

  it("should handle errors in ENTITY_LEFT events", async () => {
    // Get the ENTITY_LEFT handler
    const bootstrapPluginEvents = bootstrapPlugin.events;
    const bootstrapPluginEventsEntityLeft =
      bootstrapPluginEvents?.[EventType.ENTITY_LEFT];
    const entityLeftHandler = bootstrapPluginEventsEntityLeft?.[0];
    expect(entityLeftHandler).toBeDefined();

    // Simulate error in getEntityById
    mockRuntime.getEntityById = vi
      .fn()
      .mockRejectedValue(new Error("Entity not found"));

    if (entityLeftHandler) {
      // Should not throw when handling error
      let error: Error | undefined;
      try {
        await entityLeftHandler({
          runtime: mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
          entityId: "test-entity-id" as UUID,
          worldId: "test-world-id" as UUID,
          source: "test",
        } as EntityPayload);
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeUndefined();

      // Should not call updateEntity
      expect(mockRuntime.updateEntity).not.toHaveBeenCalled();
    }
  });
});

describe("Event Lifecycle Events", () => {
  let mockRuntime: MockRuntime;

  beforeEach(() => {
    // Use setupActionTest for consistent test setup
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should handle ACTION_STARTED events", async () => {
    // Get the ACTION_STARTED handler
    const bootstrapPluginEvents = bootstrapPlugin.events;
    const bootstrapPluginEventsActionStarted =
      bootstrapPluginEvents?.[EventType.ACTION_STARTED];
    const actionStartedHandler = bootstrapPluginEventsActionStarted?.[0];
    expect(actionStartedHandler).toBeDefined();

    if (actionStartedHandler) {
      // Call the handler with our mock payload
      await actionStartedHandler({
        runtime: mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
        actionId: "test-action-id" as UUID,
        actionName: "test-action",
        startTime: Date.now(),
        source: "test",
        roomId: "test-room-id" as UUID,
        world: "test-world-id" as UUID,
        content: { text: "test content" },
      } as ActionEventPayload);

      // No assertions needed - this just logs information
      expect(true).toBe(true);
    }
  });

  it("should handle ACTION_COMPLETED events", async () => {
    // Get the ACTION_COMPLETED handler
    const bootstrapPluginEvents = bootstrapPlugin.events;
    const bootstrapPluginEventsActionCompleted =
      bootstrapPluginEvents?.[EventType.ACTION_COMPLETED];
    const actionCompletedHandler = bootstrapPluginEventsActionCompleted?.[0];
    expect(actionCompletedHandler).toBeDefined();

    if (actionCompletedHandler) {
      // Call the handler with our mock payload
      await actionCompletedHandler({
        runtime: mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
        actionId: "test-action-id" as UUID,
        actionName: "test-action",
        completed: true,
        source: "test",
        roomId: "test-room-id" as UUID,
        world: "test-world-id" as UUID,
        content: { text: "test content" },
      } as ActionEventPayload);

      // No assertions needed - this just logs information
      expect(true).toBe(true);
    }
  });

  it("should handle ACTION_COMPLETED events with errors", async () => {
    // Get the ACTION_COMPLETED handler
    const bootstrapPluginEvents = bootstrapPlugin.events;
    const bootstrapPluginEventsActionCompleted =
      bootstrapPluginEvents?.[EventType.ACTION_COMPLETED];
    const actionCompletedHandler = bootstrapPluginEventsActionCompleted?.[0];
    expect(actionCompletedHandler).toBeDefined();

    if (actionCompletedHandler) {
      // Call the handler with our mock payload including an error
      await actionCompletedHandler({
        runtime: mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
        actionId: "test-action-id" as UUID,
        actionName: "test-action",
        completed: false,
        error: new Error("Action failed"),
        source: "test",
        roomId: "test-room-id" as UUID,
        world: "test-world-id" as UUID,
        content: { text: "test content" },
      } as ActionEventPayload);

      // No assertions needed - this just logs information
      expect(true).toBe(true);
    }
  });

  it("should handle EVALUATOR_STARTED events", async () => {
    // Get the EVALUATOR_STARTED handler
    const bootstrapPluginEvents = bootstrapPlugin.events;
    const bootstrapPluginEventsEvaluatorStarted =
      bootstrapPluginEvents?.[EventType.EVALUATOR_STARTED];
    const evaluatorStartedHandler = bootstrapPluginEventsEvaluatorStarted?.[0];
    expect(evaluatorStartedHandler).toBeDefined();

    if (evaluatorStartedHandler) {
      // Call the handler with our mock payload
      await evaluatorStartedHandler({
        runtime: mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
        evaluatorId: "test-evaluator-id" as UUID,
        evaluatorName: "test-evaluator",
        startTime: Date.now(),
        source: "test",
      } as EvaluatorEventPayload);

      // No assertions needed - this just logs information
      expect(true).toBe(true);
    }
  });

  it("should handle EVALUATOR_COMPLETED events", async () => {
    // Get the EVALUATOR_COMPLETED handler
    const bootstrapPluginEvents = bootstrapPlugin.events;
    const bootstrapPluginEventsEvaluatorCompleted =
      bootstrapPluginEvents?.[EventType.EVALUATOR_COMPLETED];
    const evaluatorCompletedHandler =
      bootstrapPluginEventsEvaluatorCompleted?.[0];
    expect(evaluatorCompletedHandler).toBeDefined();

    if (evaluatorCompletedHandler) {
      // Call the handler with our mock payload
      await evaluatorCompletedHandler({
        runtime: mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
        evaluatorId: "test-evaluator-id" as UUID,
        evaluatorName: "test-evaluator",
        completed: true,
        source: "test",
      } as EvaluatorEventPayload);

      // No assertions needed - this just logs information
      expect(true).toBe(true);
    }
  });
});

describe("shouldRespond with mentionContext", () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;

  beforeEach(() => {
    const setup = setupActionTest({
      messageOverrides: {
        content: {
          text: "Hello there",
          channelType: ChannelType.GROUP,
          source: "discord",
        } as Content,
      },
    });
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
  });

  it("should skip evaluation and respond for DM channels", () => {
    const { shouldRespond } = require("../index");

    const room = { type: ChannelType.DM };
    const result = shouldRespond(
      mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
      mockMessage as Memory,
      room,
    );

    expect(result.skipEvaluation).toBe(true);
    expect(result.shouldRespond).toBe(true);
    expect(result.reason).toContain("private channel");
  });

  it("should skip evaluation and respond for platform mentions (isMention=true)", () => {
    const { shouldRespond } = require("../index");

    const room = { type: ChannelType.GROUP };
    const mentionContext = {
      isMention: true,
      isReply: false,
      isThread: false,
      mentionType: "platform_mention" as const,
    };

    const result = shouldRespond(
      mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
      mockMessage as Memory,
      room,
      mentionContext,
    );

    expect(result.skipEvaluation).toBe(true);
    expect(result.shouldRespond).toBe(true);
    expect(result.reason).toContain("platform mention");
  });

  it("should skip evaluation and respond for replies to bot (isReply=true)", () => {
    const { shouldRespond } = require("../index");

    const room = { type: ChannelType.GROUP };
    const mentionContext = {
      isMention: false,
      isReply: true,
      isThread: false,
      mentionType: "reply" as const,
    };

    const result = shouldRespond(
      mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
      mockMessage as Memory,
      room,
      mentionContext,
    );

    expect(result.skipEvaluation).toBe(true);
    expect(result.shouldRespond).toBe(true);
    expect(result.reason).toContain("platform reply");
  });

  it("should NOT skip evaluation for regular messages without mention", () => {
    const { shouldRespond } = require("../index");

    const room = { type: ChannelType.GROUP };
    const mentionContext = {
      isMention: false,
      isReply: false,
      isThread: false,
      mentionType: "none" as const,
    };

    const result = shouldRespond(
      mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
      mockMessage as Memory,
      room,
      mentionContext,
    );

    expect(result.skipEvaluation).toBe(false);
    expect(result.reason).toContain("needs LLM evaluation");
  });

  it("should skip evaluation and respond for client_chat source", () => {
    const { shouldRespond } = require("../index");

    const room = { type: ChannelType.GROUP };
    const messageWithClientChat = {
      ...mockMessage,
      content: {
        ...mockMessage.content,
        source: "client_chat",
      },
    };

    const result = shouldRespond(
      mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
      messageWithClientChat as Memory,
      room,
    );

    expect(result.skipEvaluation).toBe(true);
    expect(result.shouldRespond).toBe(true);
    expect(result.reason).toContain("whitelisted source");
  });

  it("should be platform agnostic (works for any platform)", () => {
    const { shouldRespond } = require("../index");

    const room = { type: ChannelType.GROUP };

    // Test with different platform sources
    const platforms = ["discord", "telegram", "x", "slack"];

    platforms.forEach((platform) => {
      const mentionContext = {
        isMention: true,
        isReply: false,
        isThread: false,
        mentionType: "platform_mention" as const,
      };

      const messageWithPlatform = {
        ...mockMessage,
        content: {
          ...mockMessage.content,
          source: platform,
        },
      };

      const result = shouldRespond(
        mockRuntime as Partial<IAgentRuntime> as IAgentRuntime,
        messageWithPlatform as Memory,
        room,
        mentionContext,
      );

      expect(result.skipEvaluation).toBe(true);
      expect(result.shouldRespond).toBe(true);
    });
  });
});
