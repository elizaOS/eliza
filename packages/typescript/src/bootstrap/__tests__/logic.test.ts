import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActionEventPayload,
  Content,
  EntityPayload,
  EvaluatorEventPayload,
  IAgentRuntime,
  Memory,
  MessagePayload,
  UUID,
} from "../../types/index.ts";
import { ChannelType, EventType, ModelType } from "../../types/index.ts";
import { createBootstrapPlugin, shouldRespond } from "../index";
import {
  cleanupTestRuntime,
  createTestMemory,
  createTestRuntime,
} from "./test-utils";

// Create the bootstrap plugin for testing
const bootstrapPlugin = createBootstrapPlugin();

describe("Message Handler Logic", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    // Create real runtime
    runtime = await createTestRuntime();

    // Spy on runtime methods for testing message handlers
    vi.spyOn(runtime, "useModel").mockImplementation(
      async (modelType, params) => {
        const paramsObj = params as { prompt?: string } | undefined;
        const paramsPrompt = paramsObj?.prompt;
        if (
          paramsPrompt &&
          typeof paramsPrompt === "string" &&
          paramsPrompt.includes("should respond template")
        ) {
          return JSON.stringify({
            action: "RESPOND",
            providers: ["facts", "time"],
            reasoning: "Message requires a response",
          });
        } else if (modelType === ModelType.TEXT_SMALL) {
          return JSON.stringify({
            thought: "I will respond to this message",
            actions: ["reply"],
            content: "Hello, how can I help you today?",
          });
        } else if (modelType === ModelType.TEXT_EMBEDDING) {
          return [0.1, 0.2, 0.3];
        }
        return {};
      },
    );

    vi.spyOn(runtime, "composeState").mockResolvedValue({
      values: {
        agentName: "Test Agent",
        recentMessages: "User: Test message",
      },
      data: {
        room: { id: "test-room-id", type: ChannelType.GROUP },
      },
      text: "",
    });

    vi.spyOn(runtime, "getRoom").mockResolvedValue({
      id: "test-room-id" as UUID,
      name: "Test Room",
      type: ChannelType.GROUP,
      worldId: "test-world-id" as UUID,
      serverId: "test-server-id",
      source: "test",
    });

    vi.spyOn(runtime, "getParticipantUserState").mockResolvedValue("ACTIVE");

    // Update character templates
    runtime.character = {
      ...runtime.character,
      templates: {
        ...runtime.character.templates,
        messageHandlerTemplate:
          "Test message handler template {{recentMessages}}",
        shouldRespondTemplate:
          "Test should respond template {{recentMessages}}",
      },
    };
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should register all expected event handlers", () => {
    // Verify bootstrap plugin has event handlers
    expect(bootstrapPlugin.events).toBeDefined();

    // Check for mandatory event handlers
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
});

describe("Reaction Events", () => {
  let runtime: IAgentRuntime;
  let mockReaction: Memory;

  beforeEach(async () => {
    // Create real runtime
    runtime = await createTestRuntime();

    // Create test message
    mockReaction = createTestMemory({
      content: {
        text: "👍",
        reaction: true,
        referencedMessageId: "original-message-id",
      } as Content,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should store reaction messages correctly", async () => {
    // Spy on createMemory
    vi.spyOn(runtime, "createMemory").mockResolvedValue(mockReaction.id);

    // Get the REACTION_RECEIVED handler
    const bootstrapPluginEvents = bootstrapPlugin.events;
    const bootstrapPluginEventsReaction =
      bootstrapPluginEvents?.[EventType.REACTION_RECEIVED];
    const reactionHandler = bootstrapPluginEventsReaction?.[0];
    expect(reactionHandler).toBeDefined();

    if (reactionHandler) {
      // Call the handler with our mock payload
      await reactionHandler({
        runtime,
        message: mockReaction,
        source: "test",
      } as MessagePayload);

      // Verify reaction was stored
      expect(runtime.createMemory).toHaveBeenCalledWith(
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
    vi.spyOn(runtime, "createMemory").mockRejectedValue({ code: "23505" });

    if (reactionHandler) {
      // Current implementation propagates errors - test that error is thrown
      await expect(
        reactionHandler({
          runtime,
          message: mockReaction,
          source: "test",
        } as MessagePayload),
      ).rejects.toMatchObject({ code: "23505" });
    }
  });
});

describe("World and Entity Events", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    // Create real runtime
    runtime = await createTestRuntime();

    // Spy on runtime methods
    vi.spyOn(runtime, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(runtime, "ensureWorldExists").mockResolvedValue(undefined);
    vi.spyOn(runtime, "ensureRoomExists").mockResolvedValue(undefined);
    vi.spyOn(runtime, "getEntityById").mockImplementation(async (entityId) => {
      return {
        id: entityId,
        names: ["Test User"],
        agentId: runtime.agentId,
        metadata: {
          status: "ACTIVE",
          // Add source-specific metadata to fix the test
          test: {
            username: "testuser",
            name: "Test User",
            userId: "original-id-123",
          },
        },
      };
    });
    vi.spyOn(runtime, "updateEntity").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
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
        runtime,
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
      expect(runtime.ensureConnection).toHaveBeenCalled();
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
        runtime,
        entityId: "test-entity-id" as UUID,
        worldId: "test-world-id" as UUID,
        source: "test",
      } as EntityPayload);

      // Verify entity was updated
      expect(runtime.getEntityById).toHaveBeenCalledWith("test-entity-id");
      expect(runtime.updateEntity).toHaveBeenCalledWith(
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
    vi.spyOn(runtime, "getEntityById").mockRejectedValue(
      new Error("Entity not found"),
    );

    if (entityLeftHandler) {
      // Current implementation propagates errors - test that error is thrown
      await expect(
        entityLeftHandler({
          runtime,
          entityId: "test-entity-id" as UUID,
          worldId: "test-world-id" as UUID,
          source: "test",
        } as EntityPayload),
      ).rejects.toThrow("Entity not found");

      // Should not call updateEntity since error was thrown before that
      expect(runtime.updateEntity).not.toHaveBeenCalled();
    }
  });
});

describe("Event Lifecycle Events", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    // Create real runtime
    runtime = await createTestRuntime();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
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
        runtime,
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
        runtime,
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
        runtime,
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
        runtime,
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
        runtime,
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
  let runtime: IAgentRuntime;
  let mockMessage: Memory;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    mockMessage = createTestMemory({
      content: {
        text: "Hello there",
        channelType: ChannelType.GROUP,
        source: "discord",
      } as Content,
    });
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should skip evaluation and respond for DM channels", () => {
    const room = { type: ChannelType.DM };
    const result = shouldRespond(runtime, mockMessage, room);

    expect(result.skipEvaluation).toBe(true);
    expect(result.shouldRespond).toBe(true);
    expect(result.reason).toContain("private channel");
  });

  it("should skip evaluation and respond for platform mentions (isMention=true)", () => {
    const room = { type: ChannelType.GROUP };
    const mentionContext = {
      isMention: true,
      isReply: false,
      isThread: false,
      mentionType: "platform_mention" as const,
    };

    const result = shouldRespond(runtime, mockMessage, room, mentionContext);

    expect(result.skipEvaluation).toBe(true);
    expect(result.shouldRespond).toBe(true);
    expect(result.reason).toContain("platform mention");
  });

  it("should skip evaluation and respond for replies to bot (isReply=true)", () => {
    const room = { type: ChannelType.GROUP };
    const mentionContext = {
      isMention: false,
      isReply: true,
      isThread: false,
      mentionType: "reply" as const,
    };

    const result = shouldRespond(runtime, mockMessage, room, mentionContext);

    expect(result.skipEvaluation).toBe(true);
    expect(result.shouldRespond).toBe(true);
    expect(result.reason).toContain("platform reply");
  });

  it("should NOT skip evaluation for regular messages without mention", () => {
    const room = { type: ChannelType.GROUP };
    const mentionContext = {
      isMention: false,
      isReply: false,
      isThread: false,
      mentionType: "none" as const,
    };

    const result = shouldRespond(runtime, mockMessage, room, mentionContext);

    expect(result.skipEvaluation).toBe(false);
    expect(result.reason).toContain("needs LLM evaluation");
  });

  it("should skip evaluation and respond for client_chat source", () => {
    const room = { type: ChannelType.GROUP };
    const messageWithClientChat = createTestMemory({
      content: {
        ...mockMessage.content,
        source: "client_chat",
      } as Content,
    });

    const result = shouldRespond(runtime, messageWithClientChat, room);

    expect(result.skipEvaluation).toBe(true);
    expect(result.shouldRespond).toBe(true);
    expect(result.reason).toContain("whitelisted source");
  });

  it("should be platform agnostic (works for any platform)", () => {
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

      const messageWithPlatform = createTestMemory({
        content: {
          ...mockMessage.content,
          source: platform,
        } as Content,
      });

      const result = shouldRespond(
        runtime,
        messageWithPlatform,
        room,
        mentionContext,
      );

      expect(result.skipEvaluation).toBe(true);
      expect(result.shouldRespond).toBe(true);
    });
  });
});
