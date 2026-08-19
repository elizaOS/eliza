/**
 * Tests the Twilio helpers over a mocked fetch: credential reads from env, SMS
 * and voice dispatch (including retry and the segment-based billing breakdown),
 * with fast-check fuzzing the billing math. No live Twilio calls.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioSms,
  sendTwilioVoiceCall,
  type TwilioCredentials,
} from "./twilio.js";

const credentials: TwilioCredentials = {
  accountSid: "AC123",
  authToken: "token",
  fromPhoneNumber: "+15550000000",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.ELIZA_MOCK_TWILIO_BASE;
  delete process.env.TWILIO_SMS_COST_PER_SEGMENT_USD;
});

describe("Twilio transport", () => {
  it("reads complete credentials from an env object", () => {
    expect(
      readTwilioCredentialsFromEnv({
        TWILIO_ACCOUNT_SID: " AC123 ",
        TWILIO_AUTH_TOKEN: " token ",
        TWILIO_PHONE_NUMBER: " +15550000000 ",
      } as NodeJS.ProcessEnv),
    ).toEqual(credentials);

    expect(readTwilioCredentialsFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("sends SMS requests and attaches billing metadata", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    process.env.TWILIO_SMS_COST_PER_SEGMENT_USD = "0.01";
    const fetchMock = vi.fn(async () =>
      Response.json({ sid: "SM123" }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTwilioSms({
      credentials,
      to: "+15551112222",
      body: "hello",
      idempotencyKey: "approval:req-123:twilio",
    });

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      sid: "SM123",
      billing: {
        segments: 1,
        rawCost: 0.01,
        markup: 0,
        billedCost: 0.01,
        costPerSegment: 0.01,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://twilio.test/2010-04-01/Accounts/AC123/Messages.json",
      expect.objectContaining({
        method: "POST",
        body: "To=%2B15551112222&From=%2B15550000000&Body=hello",
        headers: expect.objectContaining({
          "I-Twilio-Idempotency-Token": "approval:req-123:twilio",
        }),
      }),
    );
  });

  it("rejects blank required SMS fields before contacting Twilio", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendTwilioSms({ credentials, to: "   ", body: "hello" }),
    ).resolves.toMatchObject({
      ok: false,
      status: null,
      error: "to must be a non-empty string",
    });

    await expect(
      sendTwilioSms({ credentials, to: "+15551112222", body: "\n\t" }),
    ).resolves.toMatchObject({
      ok: false,
      status: null,
      error: "body must be a non-empty string",
    });

    await expect(
      sendTwilioSms({
        credentials: { ...credentials, authToken: " " },
        to: "+15551112222",
        body: "hello",
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: null,
      error: "credentials.authToken must be a non-empty string",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry permanent Twilio 4xx failures", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchMock = vi.fn(async () =>
      Response.json({ message: "Invalid To number" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendTwilioSms({
        credentials,
        to: "+15551112222",
        body: "hello",
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: "Invalid To number",
      retryCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles non-JSON Twilio errors without throwing", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchMock = vi.fn(
      async () =>
        new Response("not json", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    const promise = sendTwilioSms({
      credentials,
      to: "+15551112222",
      body: "hello",
    });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(promise).resolves.toMatchObject({
      ok: false,
      status: 503,
      error: "HTTP 503",
      retryCount: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("keeps hostile SMS body bytes inside the form-encoded Body field", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchMock = vi.fn(async () =>
      Response.json({ sid: "SM123" }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fc.assert(
      fc.asyncProperty(
        fc
          .string()
          .filter((body) => body.trim().length > 0)
          .map((body) => body.slice(0, 1_000)),
        async (body) => {
          fetchMock.mockClear();
          await expect(
            sendTwilioSms({
              credentials,
              to: "+15551112222",
              body,
            }),
          ).resolves.toMatchObject({ ok: true });

          const calls = fetchMock.mock.calls as unknown as Array<
            [string, RequestInit]
          >;
          const requestInit = calls[0]?.[1];
          const requestBody = String(requestInit?.body);
          const params = new URLSearchParams(requestBody);
          expect(params.get("Body")).toBe(body);
          expect(params.getAll("Body")).toHaveLength(1);
          expect(params.get("To")).toBe("+15551112222");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("escapes TwiML for voice calls", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchMock = vi.fn(async () =>
      Response.json({ sid: "CA123" }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTwilioVoiceCall({
      credentials,
      to: "+15551112222",
      message: "Use <admin> & confirm",
    });

    expect(result).toMatchObject({ ok: true, status: 201, sid: "CA123" });
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    const requestInit = calls[0]?.[1];
    const body = new URLSearchParams(String(requestInit?.body));
    expect(body.get("Twiml")).toBe(
      "<Response><Say>Use &lt;admin&gt; &amp; confirm</Say></Response>",
    );
  });

  it("rejects blank voice-call inputs before contacting Twilio", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendTwilioVoiceCall({
        credentials,
        to: "+15551112222",
        message: " ",
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: null,
      error: "message must be a non-empty string",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  function idempotencyTokensFromCalls(
    fetchMock: ReturnType<typeof vi.fn>,
  ): Array<string | undefined> {
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    return calls.map(([, init]) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return headers["I-Twilio-Idempotency-Token"];
    });
  }

  it("reuses one generated idempotency token across an SMS network-retry", async () => {
    // Regression for #22382: a post-send network drop then a 201 must not
    // deliver a duplicate, doubly-billed SMS. Both /Messages.json POSTs have
    // to carry the SAME generated I-Twilio-Idempotency-Token so Twilio
    // deduplicates the retry, even though the caller supplied no key.
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("network timeout after send");
      }
      return Response.json({ sid: "SM123" }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    const promise = sendTwilioSms({
      credentials,
      to: "+15551112222",
      body: "hello",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toMatchObject({ ok: true, status: 201, retryCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const paths = (
      fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    ).map(([url]) => url);
    expect(paths).toEqual([
      "https://twilio.test/2010-04-01/Accounts/AC123/Messages.json",
      "https://twilio.test/2010-04-01/Accounts/AC123/Messages.json",
    ]);
    const tokens = idempotencyTokensFromCalls(fetchMock);
    expect(tokens[0]).toBeTruthy();
    expect(tokens[0]).toBe(tokens[1]);
  });

  it("reuses one generated idempotency token across a voice network-retry", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("network timeout after send");
      }
      return Response.json({ sid: "CA123" }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    const promise = sendTwilioVoiceCall({
      credentials,
      to: "+15551112222",
      message: "reminder",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toMatchObject({ ok: true, status: 201, retryCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const paths = (
      fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    ).map(([url]) => url);
    expect(paths).toEqual([
      "https://twilio.test/2010-04-01/Accounts/AC123/Calls.json",
      "https://twilio.test/2010-04-01/Accounts/AC123/Calls.json",
    ]);
    const tokens = idempotencyTokensFromCalls(fetchMock);
    expect(tokens[0]).toBeTruthy();
    expect(tokens[0]).toBe(tokens[1]);
  });

  it("keeps a stable idempotency token across all 5xx retry attempts", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt < 3) {
        return Response.json({ message: "overloaded" }, { status: 503 });
      }
      return Response.json({ sid: "SM999" }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    const promise = sendTwilioSms({
      credentials,
      to: "+15551112222",
      body: "hello",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toMatchObject({ ok: true, status: 201, retryCount: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const tokens = idempotencyTokensFromCalls(fetchMock);
    expect(tokens[0]).toBeTruthy();
    expect(new Set(tokens).size).toBe(1);
  });

  it("honors a caller-supplied idempotency token verbatim", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchMock = vi.fn(async () =>
      Response.json({ sid: "SM123" }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendTwilioSms({
      credentials,
      to: "+15551112222",
      body: "hello",
      idempotencyKey: "approval:req-123:twilio",
    });

    expect(idempotencyTokensFromCalls(fetchMock)).toEqual([
      "approval:req-123:twilio",
    ]);
  });

  it("assigns distinct tokens to two independent SMS sends", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchMock = vi.fn(async () =>
      Response.json({ sid: "SM123" }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendTwilioSms({ credentials, to: "+15551112222", body: "one" });
    await sendTwilioSms({ credentials, to: "+15551112222", body: "two" });

    const tokens = idempotencyTokensFromCalls(fetchMock);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBeTruthy();
    expect(tokens[1]).toBeTruthy();
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});
