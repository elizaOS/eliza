import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import {
  crossChannelSendAction,
  dispatchCrossChannelSend,
} from "../src/actions/cross-channel-send.js";

const SAME_ID = "00000000-0000-0000-0000-000000000001";

function makeRuntime() {
  return { agentId: SAME_ID } as unknown as Parameters<
    NonNullable<typeof crossChannelSendAction.handler>
  >[0];
}

function makeMessage() {
  return {
    entityId: SAME_ID,
    roomId: "00000000-0000-0000-0000-000000000002",
    content: { text: "send" },
  } as unknown as Parameters<
    NonNullable<typeof crossChannelSendAction.handler>
  >[1];
}

describe("crossChannelSendAction", () => {
  test("returns a draft before dispatching", async () => {
    const result = await crossChannelSendAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          channel: "imessage",
          target: "+15551112222",
          message: "hi",
        },
      },
    );
    const r = result as {
      success: boolean;
      values?: {
        channel?: string;
        draft?: boolean;
        message?: string;
        target?: string;
      };
      text: string;
    };
    expect(r.success).toBe(true);
    expect(r.values?.draft).toBe(true);
    expect(r.values?.channel).toBe("imessage");
    expect(r.values?.target).toBe("+15551112222");
    expect(r.values?.message).toBe("hi");
    expect(r.text).toMatch(/Draft|draft/);
  });

  test("invalid channel returns error", async () => {
    const result = await crossChannelSendAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          channel: "unknown_channel",
          target: "alice",
          message: "x",
          confirmed: true,
        },
      },
    );
    const r = result as { success: boolean; values?: { error?: string } };
    expect(r.success).toBe(false);
    expect(r.values?.error).toBe("UNKNOWN_CHANNEL");
  });

  test("missing channel returns MISSING_CHANNEL", async () => {
    const result = await crossChannelSendAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { target: "x", message: "y" } },
    );
    const r = result as { success: boolean; values?: { error?: string } };
    expect(r.success).toBe(false);
    expect(r.values?.error).toBe("MISSING_CHANNEL");
  });
});

describe("dispatchCrossChannelSend", () => {
  const fakeRuntime = { agentId: SAME_ID } as unknown as IAgentRuntime;
  type DispatchService = Parameters<typeof dispatchCrossChannelSend>[0]["service"];

  test("imessage dispatcher forwards { to, text } and returns channel metadata", async () => {
    const captured: unknown[] = [];
    const fakeService = {
      sendIMessage: async (req: unknown) => {
        captured.push(req);
        return { ok: true, messageId: "im-123" };
      },
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: fakeService as DispatchService,
      channel: "imessage",
      target: "+15551112222",
      body: "ping",
    });

    expect(captured).toEqual([{ to: "+15551112222", text: "ping" }]);
    expect(result.success).toBe(true);
    expect(result.values?.success).toBe(true);
    expect(result.values?.channel).toBe("imessage");
    expect(result.values?.target).toBe("+15551112222");
    expect(result.data?.actionName).toBe("OWNER_SEND_MESSAGE");
    expect(result.data?.channel).toBe("imessage");
    expect(result.data?.target).toBe("+15551112222");
    expect(result.data?.message).toBe("ping");
  });

  test("telegram dispatcher forwards { target, message }", async () => {
    const captured: unknown[] = [];
    const fakeService = {
      sendTelegramMessage: async (req: unknown) => {
        captured.push(req);
        return { ok: true };
      },
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: fakeService as DispatchService,
      channel: "telegram",
      target: "alice",
      body: "tg-body",
    });

    expect(captured).toEqual([{ target: "alice", message: "tg-body" }]);
    expect(result.success).toBe(true);
    expect(result.values?.channel).toBe("telegram");
  });

  test("whatsapp dispatcher forwards { to, text }", async () => {
    const captured: unknown[] = [];
    const fakeService = {
      sendWhatsAppMessage: async (req: unknown) => {
        captured.push(req);
        return { ok: true };
      },
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: fakeService as DispatchService,
      channel: "whatsapp",
      target: "+15553334444",
      body: "wa-hi",
    });

    expect(captured).toEqual([{ to: "+15553334444", text: "wa-hi" }]);
    expect(result.success).toBe(true);
    expect(result.values?.channel).toBe("whatsapp");
  });

  test("email dispatcher requires a subject before calling the service", async () => {
    let called = false;
    const fakeService = {
      sendGmailMessage: async () => {
        called = true;
        throw new Error("should not send without a subject");
      },
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: fakeService as DispatchService,
      channel: "email",
      target: "alice@example.com",
      body: "the body",
    });

    expect(called).toBe(false);
    expect(result.success).toBe(false);
    expect(result.values?.error).toBe("MISSING_SUBJECT");
  });

  test("email dispatcher forwards the Gmail send request shape", async () => {
    const captured: unknown[] = [];
    const fakeService = {
      sendGmailMessage: async (...args: unknown[]) => {
        captured.push(args);
        return { ok: true };
      },
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: fakeService as DispatchService,
      channel: "email",
      target: "alice@example.com",
      body: "the body",
      subject: "hello",
    });

    expect(captured).toEqual([
      [
        new URL("http://internal.invalid/lifeops/gmail/send"),
        {
          to: ["alice@example.com"],
          subject: "hello",
          bodyText: "the body",
          confirmSend: true,
        },
      ],
    ]);
    expect(result.success).toBe(true);
    expect(result.data?.subject).toBe("hello");
  });

  test("imessage dispatcher surfaces a failure when the service method is missing", async () => {
    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: {} as DispatchService,
      channel: "imessage",
      target: "+15551112222",
      body: "ping",
    });

    expect(result.success).toBe(false);
    expect(result.values?.error).toContain("not loaded");
    expect(result.values?.channel).toBe("imessage");
  });

  test("imessage dispatcher surfaces thrown transport errors", async () => {
    const fakeService = {
      sendIMessage: async () => {
        throw new Error("relay offline");
      },
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: fakeService as DispatchService,
      channel: "imessage",
      target: "+15551112222",
      body: "ping",
    });

    expect(result.success).toBe(false);
    expect(result.values?.error).toBe("relay offline");
    expect(result.data?.actionName).toBe("OWNER_SEND_MESSAGE");
  });
});
