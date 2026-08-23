/**
 * Unit coverage for agent-server event dispatch and the HTTP event body
 * schema. Drives the real module: Zod validation, cron/notification/system
 * routing, notification text extraction, provenance room mapping, and
 * system-action results. Runtime emitEvent, ensureConnection, and
 * messageService are capturing collaborators so assertions inspect values
 * the handler produced, not values the mock invented.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  HandlerCallback,
  IAgentRuntime,
  IMessageService,
  Memory,
  MessageProcessingResult,
} from "@elizaos/core";
import { ChannelType, stringToUuid } from "@elizaos/core";
import { dispatchEvent, EventBodySchema, type JsonObject } from "./event";

const OK_RESULT = {
  didRespond: true,
  responseMessages: [],
} as unknown as MessageProcessingResult;

const VALID_PROVENANCE = {
  source: "email",
  accountId: "acc-1",
  platformRecordId: "rec-1",
  chat: { id: "chat-1", type: "dm" as const },
};

function parseBody(body: unknown) {
  return EventBodySchema.safeParse(body);
}

function makeRuntime(options?: {
  messageService?: IMessageService | null;
  handleMessage?: IMessageService["handleMessage"];
}) {
  const emitEvent = mock(async () => {});
  const ensureConnection = mock(async () => {});
  const handleMessage =
    options?.handleMessage ??
    mock(
      async (_rt: IAgentRuntime, _mem: Memory, callback?: HandlerCallback) => {
        await callback?.({ text: "ack" });
        return OK_RESULT;
      },
    );
  const runtime = {
    emitEvent,
    ensureConnection,
    messageService:
      options && "messageService" in options
        ? options.messageService
        : ({ handleMessage } as unknown as IMessageService),
  } as unknown as IAgentRuntime;
  return { runtime, emitEvent, ensureConnection, handleMessage };
}

describe("EventBodySchema userId", () => {
  test("accepts alphanumeric, email, underscore, period, and hyphen ids", () => {
    for (const userId of [
      "u",
      "user_1",
      "user-1",
      "user.name",
      "owner@example.com",
      "a".repeat(256),
    ]) {
      const parsed = parseBody({
        userId,
        type: "cron",
        payload: {},
      });
      expect(parsed.success).toBe(true);
    }
  });

  test("rejects empty, too-long, and path-traversal userIds", () => {
    for (const userId of [
      "",
      "a".repeat(257),
      "user/1",
      "user 1",
      "user:1",
      "../etc",
      "user#1",
    ]) {
      expect(parseBody({ userId, type: "cron", payload: {} }).success).toBe(
        false,
      );
    }
  });
});

describe("EventBodySchema type and payload", () => {
  test("accepts cron, notification, and system with nested JSON payloads", () => {
    const payload = {
      n: 1,
      ok: true,
      missing: null,
      nested: { list: [1, "x", false, null] },
    };
    for (const type of ["cron", "notification", "system"] as const) {
      const parsed = parseBody({ userId: "user-1", type, payload });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.payload).toEqual(payload);
      }
    }
  });

  test("rejects unknown types and non-object payloads", () => {
    expect(
      parseBody({ userId: "user-1", type: "CRON", payload: {} }).success,
    ).toBe(false);
    expect(
      parseBody({ userId: "user-1", type: "other", payload: {} }).success,
    ).toBe(false);
    expect(
      parseBody({ userId: "user-1", type: "cron", payload: [] }).success,
    ).toBe(false);
    expect(
      parseBody({ userId: "user-1", type: "cron", payload: null }).success,
    ).toBe(false);
    expect(
      parseBody({ userId: "user-1", type: "cron", payload: "x" }).success,
    ).toBe(false);
  });
});

describe("EventBodySchema canonicalProvenance", () => {
  test("accepts a strict notification envelope for every canonical source", () => {
    for (const source of [
      "email",
      "gmail",
      "calendar",
      "google_calendar",
    ] as const) {
      const parsed = parseBody({
        userId: "owner@example.com",
        type: "notification",
        payload: {
          text: "hi",
          canonicalProvenance: { ...VALID_PROVENANCE, source },
        },
      });
      expect(parsed.success).toBe(true);
    }
  });

  test("rejects canonicalProvenance on cron and system events", () => {
    for (const type of ["cron", "system"] as const) {
      const parsed = parseBody({
        userId: "user-1",
        type,
        payload: { canonicalProvenance: VALID_PROVENANCE },
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.map((issue) => issue.message)).toContain(
          "canonicalProvenance is only accepted on notification events",
        );
      }
    }
  });

  test("rejects extra keys, unknown source, and missing required fields", () => {
    const extra = parseBody({
      userId: "user-1",
      type: "notification",
      payload: {
        canonicalProvenance: { ...VALID_PROVENANCE, extra: "nope" },
      },
    });
    expect(extra.success).toBe(false);

    const source = parseBody({
      userId: "user-1",
      type: "notification",
      payload: {
        canonicalProvenance: { ...VALID_PROVENANCE, source: "telegram" },
      },
    });
    expect(source.success).toBe(false);

    const missing = parseBody({
      userId: "user-1",
      type: "notification",
      payload: {
        canonicalProvenance: {
          source: "email",
          accountId: "acc-1",
          chat: { id: "chat-1", type: "dm" },
        },
      },
    });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(
        missing.error.issues.map((issue) => issue.path.join(".")),
      ).toContain("payload.canonicalProvenance.platformRecordId");
    }
  });

  test("enforces length bounds on provenance identifiers and senderName", () => {
    const tooLongAccount = parseBody({
      userId: "user-1",
      type: "notification",
      payload: {
        canonicalProvenance: {
          ...VALID_PROVENANCE,
          accountId: "a".repeat(129),
        },
      },
    });
    expect(tooLongAccount.success).toBe(false);

    const tooLongRecord = parseBody({
      userId: "user-1",
      type: "notification",
      payload: {
        canonicalProvenance: {
          ...VALID_PROVENANCE,
          platformRecordId: "r".repeat(257),
        },
      },
    });
    expect(tooLongRecord.success).toBe(false);

    const tooLongChat = parseBody({
      userId: "user-1",
      type: "notification",
      payload: {
        canonicalProvenance: {
          ...VALID_PROVENANCE,
          chat: { id: "c".repeat(129), type: "dm" },
        },
      },
    });
    expect(tooLongChat.success).toBe(false);

    const emptySender = parseBody({
      userId: "user-1",
      type: "notification",
      payload: {
        canonicalProvenance: { ...VALID_PROVENANCE, senderName: "" },
      },
    });
    expect(emptySender.success).toBe(false);

    const maxSender = parseBody({
      userId: "user-1",
      type: "notification",
      payload: {
        canonicalProvenance: {
          ...VALID_PROVENANCE,
          senderName: "s".repeat(255),
        },
      },
    });
    expect(maxSender.success).toBe(true);

    const tooLongSender = parseBody({
      userId: "user-1",
      type: "notification",
      payload: {
        canonicalProvenance: {
          ...VALID_PROVENANCE,
          senderName: "s".repeat(256),
        },
      },
    });
    expect(tooLongSender.success).toBe(false);
  });

  test("accepts every chat type and rejects unknown chat types", () => {
    for (const chatType of [
      "dm",
      "private",
      "direct",
      "group",
      "channel",
    ] as const) {
      const parsed = parseBody({
        userId: "user-1",
        type: "notification",
        payload: {
          canonicalProvenance: {
            ...VALID_PROVENANCE,
            chat: { id: "chat-1", type: chatType },
          },
        },
      });
      expect(parsed.success).toBe(true);
    }

    expect(
      parseBody({
        userId: "user-1",
        type: "notification",
        payload: {
          canonicalProvenance: {
            ...VALID_PROVENANCE,
            chat: { id: "chat-1", type: "room" },
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe("dispatchEvent cron", () => {
  test("emits a cron runtime event and returns an empty result", async () => {
    const { runtime, emitEvent, ensureConnection } = makeRuntime();
    const payload: JsonObject = { job: "tick" };

    const result = await dispatchEvent(
      runtime,
      "agent-1",
      "user-1",
      "cron",
      payload,
    );

    expect(result).toEqual({});
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith("cron", {
      runtime,
      source: "agent-server",
      userId: "user-1",
      payload,
    });
    expect(ensureConnection).not.toHaveBeenCalled();
  });
});

describe("dispatchEvent notification without provenance", () => {
  test("uses payload.text, default source, and the agent-user room key", async () => {
    let received: Memory | undefined;
    const handleMessage = mock(
      async (_rt: IAgentRuntime, mem: Memory, callback?: HandlerCallback) => {
        received = mem;
        await callback?.({ text: "replied" });
        return OK_RESULT;
      },
    );
    const { runtime, ensureConnection, emitEvent } = makeRuntime({
      handleMessage,
    });

    const result = await dispatchEvent(
      runtime,
      "agent-1",
      "user-1",
      "notification",
      { text: "hello" },
    );

    expect(result).toEqual({ response: "replied" });
    expect(emitEvent).not.toHaveBeenCalled();
    expect(ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: stringToUuid("user-1"),
        roomId: stringToUuid("agent-1:user-1"),
        worldId: stringToUuid(`server:${process.env.SERVER_NAME}`),
        userName: "user-1",
        source: "notification",
        channelId: "agent-1-user-1",
        type: ChannelType.DM,
      }),
    );
    expect(received?.content).toMatchObject({
      text: "hello",
      source: "notification",
      channelType: ChannelType.DM,
    });
    expect(received?.metadata).not.toMatchObject({
      provider: expect.anything(),
    });
  });

  test("falls back to payload.message, then JSON.stringify", async () => {
    const seen: string[] = [];
    const handleMessage = mock(
      async (_rt: IAgentRuntime, mem: Memory, callback?: HandlerCallback) => {
        seen.push(String(mem.content.text));
        await callback?.({ text: "ok" });
        return OK_RESULT;
      },
    );
    const { runtime } = makeRuntime({ handleMessage });

    await dispatchEvent(runtime, "agent-1", "user-1", "notification", {
      message: "from-message",
    });
    await dispatchEvent(runtime, "agent-1", "user-1", "notification", {
      text: 12,
      message: "from-message-after-non-string-text",
    });
    const objectPayload: JsonObject = { n: 1, nested: { ok: true } };
    await dispatchEvent(
      runtime,
      "agent-1",
      "user-1",
      "notification",
      objectPayload,
    );

    expect(seen).toEqual([
      "from-message",
      "from-message-after-non-string-text",
      JSON.stringify(objectPayload),
    ]);
  });

  test("returns {} when the message pipeline yields no text", async () => {
    const handleMessage = mock(
      async (_rt: IAgentRuntime, _mem: Memory, callback?: HandlerCallback) => {
        await callback?.({});
        await callback?.({ text: "" });
        return OK_RESULT;
      },
    );
    const { runtime } = makeRuntime({ handleMessage });

    const result = await dispatchEvent(
      runtime,
      "agent-1",
      "user-1",
      "notification",
      { text: "hello" },
    );
    expect(result).toEqual({});
  });

  test("concatenates successive callback texts into one response", async () => {
    const handleMessage = mock(
      async (_rt: IAgentRuntime, _mem: Memory, callback?: HandlerCallback) => {
        await callback?.({ text: "hello " });
        await callback?.({ text: "world" });
        return OK_RESULT;
      },
    );
    const { runtime } = makeRuntime({ handleMessage });

    const result = await dispatchEvent(
      runtime,
      "agent-1",
      "user-1",
      "notification",
      { text: "hi" },
    );
    expect(result).toEqual({ response: "hello world" });
  });

  test("throws when the runtime has no message service", async () => {
    const { runtime, ensureConnection } = makeRuntime({
      messageService: null,
    });

    await expect(
      dispatchEvent(runtime, "agent-1", "user-1", "notification", {
        text: "hello",
      }),
    ).rejects.toThrow("Message service unavailable");
    expect(ensureConnection).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchEvent notification with provenance", () => {
  test.each([
    ["group", ChannelType.GROUP],
    ["channel", ChannelType.GROUP],
    ["dm", ChannelType.DM],
    ["private", ChannelType.DM],
    ["direct", ChannelType.DM],
  ] as const)(
    "maps chat type %s to channel type %s and the provenance room key",
    async (chatType, channelType) => {
      let received: Memory | undefined;
      const handleMessage = mock(
        async (_rt: IAgentRuntime, mem: Memory, callback?: HandlerCallback) => {
          received = mem;
          await callback?.({ text: "ok" });
          return OK_RESULT;
        },
      );
      const { runtime, ensureConnection } = makeRuntime({ handleMessage });
      const payload: JsonObject = {
        text: "ping",
        canonicalProvenance: {
          source: "gmail",
          accountId: "acc-9",
          platformRecordId: "msg-9",
          chat: { id: "inbox", type: chatType },
        },
      };

      await dispatchEvent(
        runtime,
        "agent-1",
        "owner@example.com",
        "notification",
        payload,
      );

      expect(ensureConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "gmail",
          channelId: "gmail:acc-9:inbox",
          type: channelType,
          roomId: stringToUuid("agent-1:gmail:acc-9:inbox"),
        }),
      );
      expect(received?.content).toMatchObject({
        text: "ping",
        source: "gmail",
        channelType,
      });
      expect(received?.metadata).toMatchObject({
        type: "message",
        scope: "private",
        provider: "gmail",
        accountId: "acc-9",
        platformMessageId: "msg-9",
        sourceId: "msg-9",
        chatType,
        sender: { id: "owner@example.com" },
        gmail: {
          id: "owner@example.com",
          userId: "owner@example.com",
          entityId: stringToUuid("owner@example.com"),
          accountId: "acc-9",
          messageId: "msg-9",
          chatId: "inbox",
        },
      });
      expect(received?.metadata).not.toHaveProperty("entityName");
    },
  );

  test("stamps senderName onto metadata when the envelope includes it", async () => {
    let received: Memory | undefined;
    const handleMessage = mock(
      async (_rt: IAgentRuntime, mem: Memory, callback?: HandlerCallback) => {
        received = mem;
        await callback?.({ text: "ok" });
        return OK_RESULT;
      },
    );
    const { runtime } = makeRuntime({ handleMessage });

    await dispatchEvent(
      runtime,
      "agent-1",
      "owner@example.com",
      "notification",
      {
        text: "hi",
        canonicalProvenance: {
          ...VALID_PROVENANCE,
          source: "google_calendar",
          senderName: "Owner",
        },
      },
    );

    expect(received?.metadata).toMatchObject({
      provider: "google_calendar",
      sender: { id: "owner@example.com", name: "Owner" },
      entityName: "Owner",
      google_calendar: {
        name: "Owner",
        accountId: "acc-1",
        messageId: "rec-1",
        chatId: "chat-1",
      },
    });
  });

  test("throws when canonicalProvenance is present but malformed", async () => {
    const { runtime } = makeRuntime();
    await expect(
      dispatchEvent(runtime, "agent-1", "user-1", "notification", {
        canonicalProvenance: { source: "email" },
      }),
    ).rejects.toThrow();
  });
});

describe("dispatchEvent system", () => {
  test("health returns running status for the agent and does not emit", async () => {
    const { runtime, emitEvent } = makeRuntime();
    const result = await dispatchEvent(runtime, "agent-1", "user-1", "system", {
      action: "health",
    });
    expect(result).toEqual({ status: "running", agentId: "agent-1" });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  test("config-reload emits and reports reloaded", async () => {
    const { runtime, emitEvent } = makeRuntime();
    const payload: JsonObject = { action: "config-reload", source: "gateway" };

    const result = await dispatchEvent(
      runtime,
      "agent-1",
      "user-1",
      "system",
      payload,
    );

    expect(result).toEqual({ reloaded: true });
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith("config-reload", {
      runtime,
      source: "agent-server",
      agentId: "agent-1",
      payload,
    });
  });

  test("unknown or non-string actions acknowledge without emitting", async () => {
    const { runtime, emitEvent } = makeRuntime();

    expect(
      await dispatchEvent(runtime, "agent-1", "user-1", "system", {
        action: "restart",
      }),
    ).toEqual({});
    expect(
      await dispatchEvent(runtime, "agent-1", "user-1", "system", {
        action: 12,
      }),
    ).toEqual({});
    expect(
      await dispatchEvent(runtime, "agent-1", "user-1", "system", {}),
    ).toEqual({});
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
