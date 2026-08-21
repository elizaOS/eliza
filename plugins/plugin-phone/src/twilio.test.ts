/**
 * Tests the Twilio helpers over a mocked fetch: credential reads from env, SMS
 * and voice dispatch (including retry and the segment-based billing breakdown),
 * with fast-check fuzzing the billing math. No live Twilio calls.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTwilioProviderResource,
  readTwilioCredentialsFromEnv,
  readTwilioProviderResource,
  sendTwilioSms,
  sendTwilioVoiceCall,
  type TwilioCredentials,
} from "./twilio.js";

const credentials: TwilioCredentials = {
  accountSid: "AC123",
  authToken: "token",
  fromPhoneNumber: "+15550000000",
};
const callbackUrl =
  "https://canary.example.test/provider-canary/twilio/status?run=abc123";
const providerCredentials: TwilioCredentials = {
  accountSid: `AC${"1".repeat(32)}`,
  authToken: "a".repeat(32),
  fromPhoneNumber: "+15550000000",
};
const messageSid = `SM${"2".repeat(32)}`;
const callSid = `CA${"3".repeat(32)}`;

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
      statusCallbackUrl: callbackUrl,
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
        body: `To=%2B15551112222&From=%2B15550000000&Body=hello&StatusCallback=${encodeURIComponent(callbackUrl)}`,
        headers: expect.not.objectContaining({
          // This is an inbound Twilio webhook retry identifier, not a
          // documented outbound Messages/Calls idempotency request header.
          "I-Twilio-Idempotency-Token": expect.anything(),
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

  it.each([
    "http://canary.example.test/status",
    "https://user:secret@canary.example.test/status",
    "https://canary.example.test/status#fragment",
    "https://invalid_host.example.test/status",
    " https://canary.example.test/status",
  ])("rejects an unsafe or non-exact callback URL: %s", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendTwilioSms({
        credentials,
        to: "+15551112222",
        body: "hello",
        statusCallbackUrl: url,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: null,
      error: expect.stringContaining("statusCallbackUrl"),
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

    await expect(
      sendTwilioSms({
        credentials,
        to: "+15551112222",
        body: "hello",
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 503,
      error: "HTTP 503",
      retryCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      statusCallbackUrl: callbackUrl,
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
    expect(body.get("StatusCallback")).toBe(callbackUrl);
    expect(body.get("StatusCallbackMethod")).toBe("POST");
    expect(body.getAll("StatusCallbackEvent")).toEqual(["completed"]);
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

  it("does not replay an SMS create after an ambiguous network failure", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchMock = vi.fn(async () => {
      throw new Error("network timeout after send");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendTwilioSms({
        credentials,
        to: "+15551112222",
        body: "hello",
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: null,
      error: "network timeout after send",
      retryCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay a voice create after an ambiguous network failure", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchMock = vi.fn(async () => {
      throw new Error("network timeout after send");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendTwilioVoiceCall({
        credentials,
        to: "+15551112222",
        message: "reminder",
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: null,
      error: "network timeout after send",
      retryCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay a create when a successful response has no receipt", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchMock = vi.fn(
      async () => new Response("accepted", { status: 201 }),
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
      status: null,
      error: "Twilio accepted the request without a valid receipt",
      retryCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", {}],
    ["blank", { sid: "   " }],
    ["non-string", { sid: 123 }],
  ])(
    "rejects a successful response with a %s SID without replaying the create",
    async (_label, receipt) => {
      process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
      const fetchMock = vi.fn(async () =>
        Response.json(receipt, { status: 201 }),
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
        status: null,
        error: "Twilio accepted the request without a valid receipt",
        retryCount: 0,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("retries only an explicit known-not-processed 429 response", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt < 3) {
        return Response.json({ message: "rate limited" }, { status: 429 });
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
  });
});

function providerJson(input: {
  resourceSid: string;
  status: string;
  body?: string;
}): Record<string, unknown> {
  return {
    sid: input.resourceSid,
    account_sid: providerCredentials.accountSid,
    status: input.status,
    from: providerCredentials.fromPhoneNumber,
    to: "+15551112222",
    direction: "outbound-api",
    ...(input.body === undefined ? {} : { body: input.body }),
  };
}

describe("Twilio provider record boundary", () => {
  it("reads one exact provider resource with role-supplied credentials", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchMock = vi.fn(async () =>
      Response.json(
        providerJson({
          resourceSid: messageSid,
          status: "delivered",
          body: "hello",
        }),
      ),
    );

    await expect(
      readTwilioProviderResource({
        credentials: providerCredentials,
        resourceKind: "message",
        resourceSid: messageSid,
        fetchImpl: fetchMock,
      }),
    ).resolves.toMatchObject({
      resourceKind: "message",
      resourceSid: messageSid,
      accountSid: providerCredentials.accountSid,
      status: "delivered",
      body: "hello",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://twilio.test/2010-04-01/Accounts/${providerCredentials.accountSid}/Messages/${messageSid}.json`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(
            `${providerCredentials.accountSid}:${providerCredentials.authToken}`,
          ).toString("base64")}`,
        }),
      }),
    );
  });

  it("treats only a provider 404 as absent", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(
      readTwilioProviderResource({
        credentials: providerCredentials,
        resourceKind: "call",
        resourceSid: callSid,
        fetchImpl: fetchMock,
      }),
    ).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(
      Response.json({ message: "unauthorized" }, { status: 401 }),
    );
    await expect(
      readTwilioProviderResource({
        credentials: providerCredentials,
        resourceKind: "call",
        resourceSid: callSid,
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "TWILIO_PROVIDER_READ_REJECTED" });
  });

  it("deletes a terminal record and proves it absent with a second GET", async () => {
    process.env.ELIZA_MOCK_TWILIO_BASE = "https://twilio.test";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          providerJson({ resourceSid: callSid, status: "completed" }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(
      cleanupTwilioProviderResource({
        credentials: providerCredentials,
        resourceKind: "call",
        resourceSid: callSid,
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      disposition: "deleted",
      resourceKind: "call",
      resourceSid: callSid,
    });
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
      "GET",
      "DELETE",
      "GET",
    ]);
  });

  it("does not delete a non-terminal call record", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        providerJson({ resourceSid: callSid, status: "in-progress" }),
      ),
    );
    await expect(
      cleanupTwilioProviderResource({
        credentials: providerCredentials,
        resourceKind: "call",
        resourceSid: callSid,
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      disposition: "reconciliation-required",
      resourceKind: "call",
      resourceSid: callSid,
      reason: "resource-not-terminal",
      providerStatus: "in-progress",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires reconciliation for ambiguous or unverified deletion", async () => {
    const terminal = Response.json(
      providerJson({
        resourceSid: messageSid,
        status: "delivered",
        body: "hello",
      }),
    );
    const ambiguousFetch = vi
      .fn()
      .mockResolvedValueOnce(terminal)
      .mockRejectedValueOnce(new Error("socket closed after DELETE"));
    await expect(
      cleanupTwilioProviderResource({
        credentials: providerCredentials,
        resourceKind: "message",
        resourceSid: messageSid,
        fetchImpl: ambiguousFetch,
      }),
    ).resolves.toMatchObject({
      disposition: "reconciliation-required",
      reason: "delete-ambiguous",
    });

    const unverifiedFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          providerJson({
            resourceSid: messageSid,
            status: "delivered",
            body: "hello",
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json(
          providerJson({
            resourceSid: messageSid,
            status: "delivered",
            body: "hello",
          }),
        ),
      );
    await expect(
      cleanupTwilioProviderResource({
        credentials: providerCredentials,
        resourceKind: "message",
        resourceSid: messageSid,
        fetchImpl: unverifiedFetch,
      }),
    ).resolves.toMatchObject({
      disposition: "reconciliation-required",
      reason: "deletion-unverified",
    });
  });

  it("keeps read failures and rejected deletes reconciliation-owned", async () => {
    const readFailure = vi.fn(async () => {
      throw new Error("observer network unavailable");
    });
    await expect(
      cleanupTwilioProviderResource({
        credentials: providerCredentials,
        resourceKind: "message",
        resourceSid: messageSid,
        fetchImpl: readFailure,
      }),
    ).resolves.toMatchObject({
      disposition: "reconciliation-required",
      reason: "read-failed",
    });

    const rejectedDelete = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          providerJson({
            resourceSid: messageSid,
            status: "delivered",
            body: "hello",
          }),
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ message: "permission denied" }, { status: 403 }),
      );
    await expect(
      cleanupTwilioProviderResource({
        credentials: providerCredentials,
        resourceKind: "message",
        resourceSid: messageSid,
        fetchImpl: rejectedDelete,
      }),
    ).resolves.toMatchObject({
      disposition: "reconciliation-required",
      reason: "delete-rejected",
      httpStatus: 403,
    });
  });

  it("accepts an initial provider 404 as already-absent cleanup proof", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(
      cleanupTwilioProviderResource({
        credentials: providerCredentials,
        resourceKind: "message",
        resourceSid: messageSid,
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      disposition: "already-absent",
      resourceKind: "message",
      resourceSid: messageSid,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched provider material and malformed resource SIDs", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        providerJson({
          resourceSid: `SM${"9".repeat(32)}`,
          status: "delivered",
        }),
      ),
    );
    await expect(
      readTwilioProviderResource({
        credentials: providerCredentials,
        resourceKind: "message",
        resourceSid: messageSid,
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "TWILIO_PROVIDER_RESPONSE_MISMATCH" });
    await expect(
      readTwilioProviderResource({
        credentials: providerCredentials,
        resourceKind: "call",
        resourceSid: messageSid,
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "TWILIO_PROVIDER_READ_FAILED" });
  });
});
