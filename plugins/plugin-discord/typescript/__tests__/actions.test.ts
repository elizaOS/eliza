import type { ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { readChannel } from "../actions/readChannel";
import { searchMessages } from "../actions/searchMessages";
import { sendDM } from "../actions/sendDM";
import { sendMessage } from "../actions/sendMessage";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMessage(
  source: string,
  text = "hello",
  overrides: Partial<Memory["content"]> = {}
): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    roomId: "00000000-0000-0000-0000-000000000003",
    content: { text, source, ...overrides },
  } as Memory;
}

function createMockRuntime(
  opts: { service?: unknown; useModelResponse?: string } = {}
): IAgentRuntime {
  const {
    service = null,
    useModelResponse = '{"text": "hello from bot", "channelRef": "current"}',
  } = opts;
  return {
    getService: vi.fn().mockReturnValue(service),
    getRoom: vi.fn().mockResolvedValue({ channelId: "123456789012345678" }),
    useModel: vi.fn().mockResolvedValue(useModelResponse),
    agentId: "test-agent",
    character: { system: "You are a test agent." },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function createMockState(data: Record<string, unknown> = {}): State {
  return {
    data: {
      room: { channelId: "123456789012345678" },
      ...data,
    },
  } as unknown as State;
}

function createMockDiscordService(clientExists = true): Record<string, unknown> {
  const mockChannel = {
    id: "123456789012345678",
    name: "test-channel",
    isTextBased: () => true,
    send: vi.fn().mockResolvedValue({
      id: "msg-123",
      content: "hello from bot",
    }),
    messages: {
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Map([
            [
              "1",
              {
                id: "1",
                content: "message1",
                author: { username: "user1" },
                createdTimestamp: Date.now(),
              },
            ],
          ])
        ),
    },
    permissionsFor: vi.fn().mockReturnValue({
      has: vi.fn().mockReturnValue(true),
    }),
  };

  const mockGuild = {
    channels: {
      fetch: vi.fn().mockResolvedValue(new Map([["123456789012345678", mockChannel]])),
    },
  };

  const mockClient = clientExists
    ? {
        channels: {
          fetch: vi.fn().mockResolvedValue(mockChannel),
        },
        guilds: {
          cache: {
            first: vi.fn().mockReturnValue(mockGuild),
          },
        },
        users: {
          fetch: vi.fn().mockResolvedValue({
            id: "999888777666555444",
            username: "target-user",
            send: vi.fn().mockResolvedValue({
              id: "dm-msg-123",
              content: "hello DM",
            }),
          }),
        },
      }
    : null;

  return {
    client: mockClient,
  };
}

// ---------------------------------------------------------------------------
// SEND_MESSAGE tests
// ---------------------------------------------------------------------------

describe("SEND_MESSAGE action", () => {
  test("validates true for discord source", async () => {
    const runtime = createMockRuntime();
    const msg = createMessage("discord", "say hello");
    expect(await sendMessage.validate(runtime, msg)).toBe(true);
  });

  test("validates false for non-discord source", async () => {
    const runtime = createMockRuntime();
    const msg = createMessage("telegram", "say hello");
    expect(await sendMessage.validate(runtime, msg)).toBe(false);
  });

  test("handler returns undefined when service is unavailable", async () => {
    const runtime = createMockRuntime({ service: null });
    const msg = createMessage("discord", "send hello");
    const callback = vi.fn();
    const result = await sendMessage.handler(runtime, msg, createMockState(), undefined, callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("not available") })
    );
  });

  test("handler returns undefined when client is null", async () => {
    const service = createMockDiscordService(false);
    const runtime = createMockRuntime({ service });
    const msg = createMessage("discord", "send a message");
    const callback = vi.fn();
    await sendMessage.handler(runtime, msg, createMockState(), undefined, callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("not available") })
    );
  });
});

// ---------------------------------------------------------------------------
// SEND_DM tests
// ---------------------------------------------------------------------------

describe("SEND_DM action", () => {
  test("validates true for discord source", async () => {
    const runtime = createMockRuntime();
    const msg = createMessage("discord", "DM user hello");
    expect(await sendDM.validate(runtime, msg)).toBe(true);
  });

  test("validates false for non-discord source", async () => {
    const runtime = createMockRuntime();
    const msg = createMessage("slack", "DM user hello");
    expect(await sendDM.validate(runtime, msg)).toBe(false);
  });

  test("handler fails when service is unavailable", async () => {
    const runtime = createMockRuntime({ service: null });
    const msg = createMessage("discord", "DM user");
    const result = await sendDM.handler(runtime, msg, createMockState());
    expect(result?.success).toBe(false);
  });

  test("handler fails when client is null", async () => {
    const service = createMockDiscordService(false);
    const runtime = createMockRuntime({ service });
    const msg = createMessage("discord", "DM user");
    const result = await sendDM.handler(runtime, msg, createMockState());
    expect(result?.success).toBe(false);
  });

  test("handler fails when state is missing", async () => {
    const service = createMockDiscordService(true);
    const runtime = createMockRuntime({ service });
    const msg = createMessage("discord", "DM user");
    const callback = vi.fn();
    const result = await sendDM.handler(runtime, msg, undefined, undefined, callback);
    expect(result?.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// READ_CHANNEL tests
// ---------------------------------------------------------------------------

describe("READ_CHANNEL action", () => {
  test("validates true for discord source", async () => {
    const runtime = createMockRuntime();
    const msg = createMessage("discord", "read this channel");
    expect(await readChannel.validate(runtime, msg)).toBe(true);
  });

  test("validates false for non-discord source", async () => {
    const runtime = createMockRuntime();
    const msg = createMessage("telegram", "read channel");
    expect(await readChannel.validate(runtime, msg)).toBe(false);
  });

  test("handler fails when service is unavailable", async () => {
    const runtime = createMockRuntime({ service: null });
    const msg = createMessage("discord", "read channel");
    const result = await readChannel.handler(runtime, msg, createMockState());
    expect(result?.success).toBe(false);
  });

  test("handler fails when state is missing", async () => {
    const service = createMockDiscordService(true);
    const runtime = createMockRuntime({ service });
    const msg = createMessage("discord", "read channel");
    const callback = vi.fn();
    const result = await readChannel.handler(runtime, msg, undefined, undefined, callback);
    expect(result?.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SEARCH_MESSAGES tests
// ---------------------------------------------------------------------------

describe("SEARCH_MESSAGES action", () => {
  test("validates true for discord source", async () => {
    const runtime = createMockRuntime();
    const msg = createMessage("discord", "search for hello");
    expect(await searchMessages.validate(runtime, msg)).toBe(true);
  });

  test("validates false for non-discord source", async () => {
    const runtime = createMockRuntime();
    const msg = createMessage("api", "search for hello");
    expect(await searchMessages.validate(runtime, msg)).toBe(false);
  });

  test("handler fails when service is unavailable", async () => {
    const runtime = createMockRuntime({ service: null });
    const msg = createMessage("discord", "search messages");
    const callback = vi.fn();
    await searchMessages.handler(runtime, msg, createMockState(), undefined, callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("not available") })
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting tests
// ---------------------------------------------------------------------------

describe("Discord actions cross-cutting", () => {
  test("all four actions have name and description", () => {
    for (const action of [sendMessage, sendDM, readChannel, searchMessages]) {
      expect(typeof action.name).toBe("string");
      expect(action.name.length).toBeGreaterThan(0);
      expect(typeof action.description).toBe("string");
      expect(action.description!.length).toBeGreaterThan(0);
    }
  });

  test("all actions have handler functions", () => {
    for (const action of [sendMessage, sendDM, readChannel, searchMessages]) {
      expect(typeof action.handler).toBe("function");
      expect(typeof action.validate).toBe("function");
    }
  });
});
