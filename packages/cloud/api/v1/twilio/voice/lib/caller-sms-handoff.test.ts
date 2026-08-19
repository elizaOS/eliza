/** Tests explicit caller SMS handoffs without provider side effects. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  type CallerSmsHandoffStore,
  createCallerSmsHandoff,
} from "./caller-sms-handoff";

class TestHandoffStore implements CallerSmsHandoffStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean },
  ): Promise<string | null> {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }
}

function setup(
  overrides: {
    fromNumber?: string;
    callerNumber?: string;
    store?: CallerSmsHandoffStore;
    recordSuccess?: (event: {
      id: string;
      content: string;
      createdAt: number;
    }) => Promise<void>;
  } = {},
) {
  const send = mock(
    async (
      _accountSid: string,
      _authToken: string,
      _body: URLSearchParams,
      _idempotencyToken: string,
    ): Promise<void> => undefined,
  );
  const store = overrides.store ?? new TestHandoffStore();
  const recordSuccess = mock(
    overrides.recordSuccess ?? (async (): Promise<void> => undefined),
  );
  const handle = createCallerSmsHandoff({
    accountSid: "AC123",
    authToken: "secret",
    callSid: "CA123",
    fromNumber: overrides.fromNumber ?? "+14484080429",
    callerNumber: overrides.callerNumber ?? "+12525914471",
    store,
    recordSuccess,
    now: () => 1_700_000_000_000,
    send,
  });
  return { handle, send, store, recordSuccess };
}

describe("caller SMS handoff", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends the continuation message only to the signed caller", async () => {
    const { handle, send, recordSuccess } = setup();
    expect(await handle("Text me")).toEqual({
      handled: true,
      response: "Sent it to the number you're calling from.",
    });
    expect(send).toHaveBeenCalledTimes(1);
    const params = send.mock.calls[0]?.[2] as URLSearchParams;
    expect(Object.fromEntries(params)).toEqual({
      To: "+12525914471",
      From: "+14484080429",
      Body: "Eliza here — reply to this text to keep going after the call.",
    });
    expect(send.mock.calls[0]?.[3]).toMatch(/^[a-f0-9]{64}$/);
    expect(recordSuccess).toHaveBeenCalledWith({
      id: "twilio-call:CA123:caller-sms-handoff",
      content:
        "Voice action completed: sent the standard continuation SMS to the authenticated caller.",
      createdAt: 1_700_000_000_000,
    });
  });

  test("refuses dictated content for an unverified caller identity", async () => {
    const { handle, send } = setup();
    expect(await handle("Please text me saying Buy oat milk")).toEqual({
      handled: true,
      response:
        "I can only send the standard continuation text during a call. Say text me.",
    });
    expect(await handle("Find me a grocery store")).toEqual({ handled: false });
    expect(send).not.toHaveBeenCalled();
  });

  test("deduplicates successful requests within one call", async () => {
    const { handle, send } = setup();
    await handle("text me");
    expect(await handle("TEXT ME.")).toEqual({
      handled: true,
      response: "That text is already sent.",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("deduplicates by signed CallSid across reconstructed handlers", async () => {
    const store = new TestHandoffStore();
    const first = setup({ store });
    const reconnected = setup({ store });

    await first.handle("text me");
    expect(await reconnected.handle("text me")).toEqual({
      handled: true,
      response: "That text is already sent.",
    });
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(reconnected.send).not.toHaveBeenCalled();
  });

  test("repairs canonical history after a successful send without resending", async () => {
    const store = new TestHandoffStore();
    const firstRecord = mock(async (): Promise<void> => {
      throw new Error("history unavailable");
    });
    const first = setup({ store, recordSuccess: firstRecord });
    expect(await first.handle("text me")).toEqual({
      handled: true,
      response: "Sent it to the number you're calling from.",
    });

    const reconnected = setup({ store });
    expect(await reconnected.handle("text me")).toEqual({
      handled: true,
      response: "That text is already sent.",
    });
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(reconnected.send).not.toHaveBeenCalled();
    expect(reconnected.recordSuccess).toHaveBeenCalledTimes(1);
  });

  test("fails closed when either signed number is not E.164", async () => {
    const { handle, send } = setup({ callerNumber: "anonymous" });
    expect(await handle("text me")).toEqual({
      handled: true,
      response: "I can't safely text this call. We can keep going here.",
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("reports provider failure without claiming success", async () => {
    const send = mock(
      async (
        _accountSid: string,
        _authToken: string,
        _body: URLSearchParams,
        _idempotencyToken: string,
      ): Promise<void> => {
        throw new Error("provider unavailable");
      },
    );
    const handle = createCallerSmsHandoff({
      accountSid: "AC123",
      authToken: "secret",
      callSid: "CA123",
      fromNumber: "+14484080429",
      callerNumber: "+12525914471",
      store: new TestHandoffStore(),
      recordSuccess: async () => undefined,
      send,
    });
    expect(await handle("text me")).toEqual({
      handled: true,
      response: "I couldn't send that text. We can keep going here.",
    });
  });

  test("does not resend after an ambiguous throw following provider acceptance", async () => {
    const store = new TestHandoffStore();
    let accepted = 0;
    const ambiguousSend = mock(
      async (
        _accountSid: string,
        _authToken: string,
        _body: URLSearchParams,
        _idempotencyToken: string,
      ): Promise<void> => {
        accepted += 1;
        throw new Error("connection closed after acceptance");
      },
    );
    const first = createCallerSmsHandoff({
      accountSid: "AC123",
      authToken: "secret",
      callSid: "CA123",
      fromNumber: "+14484080429",
      callerNumber: "+12525914471",
      store,
      recordSuccess: async () => undefined,
      send: ambiguousSend,
    });
    expect(await first("text me")).toEqual({
      handled: true,
      response: "I couldn't send that text. We can keep going here.",
    });

    const reconnected = setup({ store });
    expect(await reconnected.handle("text me")).toEqual({
      handled: true,
      response: "I'm already handling that text.",
    });
    expect(accepted).toBe(1);
    expect(reconnected.send).not.toHaveBeenCalled();
  });

  test("does not announce success for a malformed Twilio receipt", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("{}", {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const handle = createCallerSmsHandoff({
      accountSid: "AC123",
      authToken: "secret",
      callSid: "CA123",
      fromNumber: "+14484080429",
      callerNumber: "+12525914471",
      store: new TestHandoffStore(),
      recordSuccess: async () => undefined,
    });

    expect(await handle("text me")).toEqual({
      handled: true,
      response: "I couldn't send that text. We can keep going here.",
    });
  });

  test("fails closed when no durable CallSid ledger is configured", async () => {
    const send = mock(async (): Promise<void> => undefined);
    const handle = createCallerSmsHandoff({
      accountSid: "AC123",
      authToken: "secret",
      callSid: "CA123",
      fromNumber: "+14484080429",
      callerNumber: "+12525914471",
      recordSuccess: async () => undefined,
      send,
    });

    expect(await handle("text me")).toEqual({
      handled: true,
      response:
        "I can't safely text this call right now. We can keep going here.",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
