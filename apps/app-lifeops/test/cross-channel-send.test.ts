/**
 * CROSS-CHANNEL SEND TESTS — mixed scope.
 *
 * Part 1 (mock-heavy handler routing — LARP caveat):
 *   The `describe("crossChannelSendAction")` block mocks `LifeOpsService`
 *   wholesale via `vi.mock("../src/lifeops/service.js", ...)`. Every
 *   `sendXMessage` method is a `vi.fn()` returning `{ ok: true }`. Assertions
 *   like `expect(sendIMessage).toHaveBeenCalledWith({ to, text })` only verify
 *   the action handler builds a payload and hands it to A LifeOpsService
 *   method named `sendIMessage`. They do NOT verify the real iMessage/WhatsApp/
 *   Telegram/Gmail code paths, transport-level errors, rate limits, or that
 *   LifeOpsService actually HAS these methods (a rename on the real class
 *   would silently keep the tests green because the mocked class still has
 *   them).
 *
 * Part 2 (real-integration — see `describe("dispatchCrossChannelSend (real dispatcher map)")`):
 *   Drives `dispatchCrossChannelSend` directly with a locally constructed
 *   fake `LifeOpsService` instance (not a `vi.mock` of the module). This
 *   exercises the REAL `CHANNEL_DISPATCHERS[channel]` lookup +
 *   `createLifeOpsMethodDispatcher` closure + `buildDispatchSuccess` /
 *   `buildDispatchFailure` branches, which is the unit under test. If
 *   `CHANNEL_DISPATCHERS.imessage` is ever rewired to a different method
 *   name or request-builder, this test catches it. If the dispatcher ever
 *   returns a payload with missing `ActionResult.values.channel` or
 *   `ActionResult.data.actionName`, this test catches that too.
 *
 * Regressions that would slip past Part 1 but get caught by Part 2:
 *   - The dispatcher map losing the `imessage` key entirely.
 *   - `createLifeOpsMethodDispatcher` passing `ctx` instead of
 *     `args.buildRequest(ctx)` to the service method.
 *   - The success branch forgetting to stamp `actionName` / `channel` /
 *     `target` into `ActionResult.values`.
 */
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

import {
  crossChannelSendAction,
  dispatchCrossChannelSend,
} from "../src/actions/cross-channel-send.js";
import type { IAgentRuntime } from "@elizaos/core";

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

/**
 * Real-integration tests against the actual `CHANNEL_DISPATCHERS` map.
 *
 * These tests construct a DispatchContext by hand and call
 * `dispatchCrossChannelSend` directly. The `LifeOpsService` argument is a
 * locally-constructed fake object (NOT a `vi.mock` of the module), so the
 * real `createLifeOpsMethodDispatcher` closure runs, the real request
 * builders run, and the real `buildDispatchSuccess` / `buildDispatchFailure`
 * response-shape code runs. The only thing faked is the transport boundary
 * (the method that would actually send bytes).
 */
describe("dispatchCrossChannelSend (real dispatcher map)", () => {
  const fakeRuntime = { agentId: SAME_ID } as unknown as IAgentRuntime;

  test("imessage dispatcher forwards { to, text } and returns ActionResult with channel, target, actionName", async () => {
    const captured: unknown[] = [];
    const fakeService = {
      sendIMessage: async (req: unknown) => {
        captured.push(req);
        return { ok: true, messageId: "im-123" };
      },
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake service
      service: fakeService as any,
      channel: "imessage",
      target: "+15551112222",
      body: "ping",
    });

    // Verify the REAL request builder produced { to, text }.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ to: "+15551112222", text: "ping" });

    // Verify the REAL buildDispatchSuccess populated every field downstream
    // consumers rely on.
    expect(result.success).toBe(true);
    expect(result.values?.success).toBe(true);
    expect(result.values?.channel).toBe("imessage");
    expect(result.values?.target).toBe("+15551112222");
    expect(result.data?.actionName).toBe("OWNER_SEND_MESSAGE");
    expect(result.data?.channel).toBe("imessage");
    expect(result.data?.target).toBe("+15551112222");
    expect(result.data?.message).toBe("ping");
    expect(result.text).toContain("Sent imessage to +15551112222");
  });

  test("telegram dispatcher forwards { target, message } (different request shape)", async () => {
    const captured: unknown[] = [];
    const fakeService = {
      sendTelegramMessage: async (req: unknown) => {
        captured.push(req);
        return { ok: true };
      },
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake service
      service: fakeService as any,
      channel: "telegram",
      target: "alice",
      body: "tg-body",
    });

    expect(captured[0]).toEqual({ target: "alice", message: "tg-body" });
    expect(result.success).toBe(true);
    expect(result.values?.channel).toBe("telegram");
  });

  test("imessage dispatcher surfaces a DISPATCH_FAILED error when the service method is missing", async () => {
    const fakeServiceMissingMethod = {}; // no sendIMessage

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      // biome-ignore lint/suspicious/noExplicitAny: missing-method fake
      service: fakeServiceMissingMethod as any,
      channel: "imessage",
      target: "+15551112222",
      body: "ping",
    });

    expect(result.success).toBe(false);
    expect(result.values?.error).toContain("not loaded");
    expect(result.values?.channel).toBe("imessage");
  });

  test("imessage dispatcher surfaces thrown transport errors via buildDispatchFailure", async () => {
    const fakeService = {
      sendIMessage: async () => {
        throw new Error("relay offline");
      },
    };

    const result = await dispatchCrossChannelSend({
      runtime: fakeRuntime,
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake service
      service: fakeService as any,
      channel: "imessage",
      target: "+15551112222",
      body: "ping",
    });

    expect(result.success).toBe(false);
    expect(result.values?.error).toBe("relay offline");
    expect(result.data?.actionName).toBe("OWNER_SEND_MESSAGE");
  });
});
