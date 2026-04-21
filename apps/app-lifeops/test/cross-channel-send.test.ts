import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const sendGmailMessage = vi.fn(async () => ({ ok: true }));
const sendIMessage = vi.fn(async () => ({ ok: true }));
const sendWhatsAppMessage = vi.fn(async () => ({ ok: true }));
const sendTelegramMessage = vi.fn(async () => ({ ok: true }));

vi.mock("../src/lifeops/service.js", () => {
  class LifeOpsService {
    sendGmailMessage = sendGmailMessage;
    sendIMessage = sendIMessage;
    sendWhatsAppMessage = sendWhatsAppMessage;
    sendTelegramMessage = sendTelegramMessage;
    constructor(_runtime: unknown) {}
  }
  return {
    LifeOpsService,
    LifeOpsServiceError: class LifeOpsServiceError extends Error {},
  };
});

import { crossChannelSendAction } from "../src/actions/cross-channel-send.js";

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

beforeEach(() => {
  sendGmailMessage.mockClear();
  sendIMessage.mockClear();
  sendWhatsAppMessage.mockClear();
  sendTelegramMessage.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("crossChannelSendAction", () => {
  test("draft (confirmed=false) returns draft without sending", async () => {
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
      values?: { draft?: boolean };
      text: string;
    };
    expect(r.success).toBe(true);
    expect(r.values?.draft).toBe(true);
    expect(r.text).toMatch(/Draft|draft/);
    expect(sendIMessage).not.toHaveBeenCalled();
  });

  test("email + confirmed=true calls sendGmailMessage", async () => {
    const result = await crossChannelSendAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          channel: "email",
          target: "alice@example.com",
          message: "the body",
          subject: "hello",
          confirmed: true,
        },
      },
    );
    const r = result as { success: boolean };
    expect(r.success).toBe(true);
    expect(sendGmailMessage).toHaveBeenCalledTimes(1);
    const [, payload] = sendGmailMessage.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(payload.to).toEqual(["alice@example.com"]);
    expect(payload.subject).toBe("hello");
    expect(payload.bodyText).toBe("the body");
  });

  test("imessage + confirmed=true calls sendIMessage with { to, text }", async () => {
    const result = await crossChannelSendAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          channel: "imessage",
          target: "+15551112222",
          message: "ping",
          confirmed: true,
        },
      },
    );
    expect((result as { success: boolean }).success).toBe(true);
    expect(sendIMessage).toHaveBeenCalledWith({
      to: "+15551112222",
      text: "ping",
    });
  });

  test("whatsapp + confirmed=true calls sendWhatsAppMessage with { to, text }", async () => {
    const result = await crossChannelSendAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          channel: "whatsapp",
          target: "+15553334444",
          message: "wa-hi",
          confirmed: true,
        },
      },
    );
    expect((result as { success: boolean }).success).toBe(true);
    expect(sendWhatsAppMessage).toHaveBeenCalledWith({
      to: "+15553334444",
      text: "wa-hi",
    });
  });

  test("telegram + confirmed=true calls sendTelegramMessage with { target, message }", async () => {
    const result = await crossChannelSendAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          channel: "telegram",
          target: "alice",
          message: "tg-hi",
          confirmed: true,
        },
      },
    );
    expect((result as { success: boolean }).success).toBe(true);
    expect(sendTelegramMessage).toHaveBeenCalledWith({
      target: "alice",
      message: "tg-hi",
    });
  });

  test("invalid channel returns error", async () => {
    const result = await crossChannelSendAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          channel: "carrier_pigeon",
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
