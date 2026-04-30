import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  crossChannelSendAction,
  dispatchCrossChannelSend,
} from "../src/actions/cross-channel-send.js";

const SAME_ID = "00000000-0000-0000-0000-000000000001";
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

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

type CrossChannelActionHandler = NonNullable<
  typeof crossChannelSendAction.handler
>;

function runCrossChannelAction(
  ...args: Parameters<CrossChannelActionHandler>
): ReturnType<CrossChannelActionHandler> {
  const handler = crossChannelSendAction.handler;
  if (!handler) {
    throw new Error("crossChannelSendAction handler is missing");
  }
  return handler(...args);
}

describe("crossChannelSendAction", () => {
  test("returns a draft before dispatching", async () => {
    const result = await runCrossChannelAction(
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
    const result = await runCrossChannelAction(
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
    const result = await runCrossChannelAction(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { target: "x", message: "y" } },
    );
    const r = result as { success: boolean; values?: { error?: string } };
    expect(r.success).toBe(false);
    expect(r.values?.error).toBe("MISSING_CHANNEL");
  });

  test("does not surface malformed planner text as a fallback response", async () => {
    const runtime = {
      ...makeRuntime(),
      useModel: vi.fn().mockResolvedValue("Sure, I can send that."),
    };

    const result = await runCrossChannelAction(
      runtime,
      makeMessage(),
      undefined,
      { parameters: {} },
    );

    const r = result as {
      success: boolean;
      text: string;
      values?: { error?: string };
    };
    expect(r.success).toBe(false);
    expect(r.values?.error).toBe("MISSING_CHANNEL");
    expect(r.text).not.toContain("Sure, I can send that.");
  });
});

describe("dispatchCrossChannelSend", () => {
  const fakeRuntime = { agentId: SAME_ID } as unknown as IAgentRuntime;
  type DispatchService = Parameters<
    typeof dispatchCrossChannelSend
  >[0]["service"];

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

  test.each([
    ["discord", "discord-room-123"],
    ["signal", "+15554445555"],
  ] as const)("%s dispatcher forwards through runtime sendMessageToTarget", async (channel, target) => {
    const captured: unknown[] = [];
    const runtime = {
      agentId: SAME_ID,
      sendMessageToTarget: async (...args: unknown[]) => {
        captured.push(args);
      },
    } as unknown as IAgentRuntime;

    const result = await dispatchCrossChannelSend({
      runtime,
      service: {} as DispatchService,
      channel,
      target,
      body: "runtime-body",
    });

    expect(captured).toEqual([
      [
        {
          source: channel,
          channelId: target,
        },
        {
          text: "runtime-body",
          source: channel,
        },
      ],
    ]);
    expect(result.success).toBe(true);
    expect(result.values?.channel).toBe(channel);
    expect(result.values?.target).toBe(target);
    expect(result.data?.actionName).toBe("OWNER_SEND_MESSAGE");
    expect(result.data?.channel).toBe(channel);
    expect(result.data?.target).toBe(target);
    expect(result.data?.message).toBe("runtime-body");
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

  test("sms dispatcher posts the exact Twilio SMS request", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_PHONE_NUMBER = "+15550000000";
    process.env.MILADY_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sid: "SM123" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: {} as DispatchService,
      channel: "sms",
      target: "+15551234567",
      body: "sms-body",
    });

    expect(result.success).toBe(true);
    expect(result.values?.channel).toBe("sms");
    expect(result.values?.sid).toBe("SM123");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://twilio.test/2010-04-01/Accounts/ACtest/Messages.json",
    );
    const body = new URLSearchParams(String(init.body));
    expect(body.get("To")).toBe("+15551234567");
    expect(body.get("From")).toBe("+15550000000");
    expect(body.get("Body")).toBe("sms-body");
  });

  test("twilio_voice dispatcher posts TwiML to the Twilio calls endpoint", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACvoice";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_PHONE_NUMBER = "+15550000000";
    process.env.MILADY_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sid: "CA123" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: {} as DispatchService,
      channel: "twilio_voice",
      target: "+15557654321",
      body: "voice body",
    });

    expect(result.success).toBe(true);
    expect(result.values?.channel).toBe("twilio_voice");
    expect(result.values?.sid).toBe("CA123");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://twilio.test/2010-04-01/Accounts/ACvoice/Calls.json",
    );
    const body = new URLSearchParams(String(init.body));
    expect(body.get("To")).toBe("+15557654321");
    expect(body.get("From")).toBe("+15550000000");
    expect(body.get("Twiml")).toBe(
      "<Response><Say>voice body</Say></Response>",
    );
  });

  test("notifications dispatcher publishes a titled ntfy push", async () => {
    process.env.NTFY_BASE_URL = "https://ntfy.test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "ntfy-1", time: 1_777_777_777 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: {} as DispatchService,
      channel: "notifications",
      target: "owner-topic",
      body: "push body",
      subject: "Heads up",
    });

    expect(result.success).toBe(true);
    expect(result.values?.channel).toBe("notifications");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.test/owner-topic");
    expect(init.body).toBe("push body");
    const headers = init.headers as Record<string, string>;
    expect(headers.Title).toBe("Heads up");
    expect(headers.Priority).toBe("3");
    const data = result.data as { result?: { messageId?: string } };
    expect(data.result?.messageId).toBe("ntfy-1");
  });

  test("calendly dispatcher creates a single-use booking link for the event type", async () => {
    process.env.ELIZA_CALENDLY_TOKEN = "cal-token";
    process.env.MILADY_MOCK_CALENDLY_BASE = "https://calendly.test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          resource: {
            booking_url: "https://calendly.com/d/abc",
            owner: "https://api.calendly.com/event_types/et1",
            owner_type: "EventType",
            expires_at: "2026-05-01T00:00:00.000Z",
          },
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: {} as DispatchService,
      channel: "calendly",
      target: "https://api.calendly.com/event_types/et1",
      body: "ignored by calendly dispatcher",
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("https://calendly.com/d/abc");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://calendly.test/scheduling_links");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cal-token");
    expect(JSON.parse(String(init.body))).toEqual({
      max_event_count: 1,
      owner: "https://api.calendly.com/event_types/et1",
      owner_type: "EventType",
    });
    expect(result.values?.bookingUrl).toBe("https://calendly.com/d/abc");
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

  test.each([
    ["telegram", "alice"],
    ["whatsapp", "+15553334444"],
  ] as const)("%s dispatcher surfaces a failure when the service method is missing", async (channel, target) => {
    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: {} as DispatchService,
      channel,
      target,
      body: "ping",
    });

    expect(result.success).toBe(false);
    expect(result.values?.error).toContain("not loaded");
    expect(result.values?.channel).toBe(channel);
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

  test.each([
    ["telegram", "sendTelegramMessage", "telegram offline"],
    ["whatsapp", "sendWhatsAppMessage", "whatsapp delivery rejected"],
  ] as const)("%s dispatcher surfaces thrown transport errors", async (channel, method, errorMessage) => {
    const fakeService = {
      [method]: async () => {
        throw new Error(errorMessage);
      },
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: fakeService as DispatchService,
      channel,
      target: channel === "telegram" ? "alice" : "+15553334444",
      body: "ping",
    });

    expect(result.success).toBe(false);
    expect(result.values?.error).toBe(errorMessage);
    expect(result.values?.channel).toBe(channel);
    expect(result.data?.actionName).toBe("OWNER_SEND_MESSAGE");
  });

  test.each([
    ["discord", "discord send failed"],
    ["signal", "signal send failed"],
  ] as const)("%s dispatcher surfaces runtime send errors", async (channel, errorMessage) => {
    const runtime = {
      agentId: SAME_ID,
      sendMessageToTarget: async () => {
        throw new Error(errorMessage);
      },
    } as unknown as IAgentRuntime;

    const result = await dispatchCrossChannelSend({
      runtime,
      service: {} as DispatchService,
      channel,
      target: channel === "discord" ? "discord-room-123" : "+15554445555",
      body: "ping",
    });

    expect(result.success).toBe(false);
    expect(result.values?.error).toBe(errorMessage);
    expect(result.values?.channel).toBe(channel);
    expect(result.data?.actionName).toBe("OWNER_SEND_MESSAGE");
  });

  test("x_dm dispatcher fails when the X API reports delivery failure", async () => {
    const fakeService = {
      sendXDirectMessage: async () => ({
        ok: false,
        status: 403,
        error: "Forbidden",
      }),
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: fakeService as DispatchService,
      channel: "x_dm",
      target: "12345",
      body: "ping",
    });

    expect(result.success).toBe(false);
    expect(result.values?.success).toBe(false);
    expect(result.values?.error).toBe("Forbidden");
    expect(result.values?.channel).toBe("x_dm");
  });

  test("x_dm dispatcher succeeds when the LifeOps X service sends the DM", async () => {
    const fakeService = {
      sendXDirectMessage: async () => ({
        ok: true,
        status: 201,
      }),
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: fakeService as DispatchService,
      channel: "x_dm",
      target: "12345",
      body: "ping",
    });

    expect(result.success).toBe(true);
    expect(result.values?.success).toBe(true);
    expect(result.values?.channel).toBe("x_dm");
  });

  test("x_dm dispatcher forwards conversation targets to the conversation send path", async () => {
    const captured: unknown[] = [];
    const fakeService = {
      sendXConversationMessage: async (req: unknown) => {
        captured.push(req);
        return { ok: true, status: 201 };
      },
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: fakeService as DispatchService,
      channel: "x_dm",
      target: "conversation:conv-123",
      body: "conversation reply",
    });

    expect(result.success).toBe(true);
    expect(captured).toEqual([
      {
        conversationId: "conv-123",
        text: "conversation reply",
        confirmSend: true,
        side: "owner",
      },
    ]);
  });

  test("x_dm dispatcher creates a DM group for comma-separated participant targets", async () => {
    const captured: unknown[] = [];
    const fakeService = {
      createXDirectMessageGroup: async (req: unknown) => {
        captured.push(req);
        return { ok: true, status: 201 };
      },
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      service: fakeService as DispatchService,
      channel: "x_dm",
      target: "12345, 67890",
      body: "group dm",
    });

    expect(result.success).toBe(true);
    expect(captured).toEqual([
      {
        participantIds: ["12345", "67890"],
        text: "group dm",
        confirmSend: true,
        side: "owner",
      },
    ]);
  });
});
