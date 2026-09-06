/**
 * sms-provider.test.ts — SEC-061: a failed Twilio send must surface only a
 * generic SmsDeliveryError. The provider error body can carry account/phone
 * metadata, so it is discarded — never thrown, never logged verbatim.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  SmsDeliveryError,
  SmsVerificationError,
  TwilioSmsProvider,
  TwilioVerifyProvider,
} from "../sms-provider";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_WARN = console.warn;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.warn = ORIGINAL_WARN;
});

const PROVIDER = new TwilioSmsProvider({
  accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  authToken: "twilio-auth-token",
  from: "+14155550000",
});

const VERIFY_SERVICE_SID = `VA${"a".repeat(32)}`;
const VERIFY_PROVIDER = new TwilioVerifyProvider({
  accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  authToken: "twilio-auth-token",
  serviceSid: VERIFY_SERVICE_SID,
  tokenTtlSeconds: 600,
});

// A realistic Twilio error payload — it names the account SID and the
// destination number, exactly the metadata that must not propagate.
const TWILIO_ERROR_BODY = JSON.stringify({
  code: 21608,
  message:
    "The number +14155550999 is unverified. Trial accounts cannot send to unverified numbers.",
  more_info: "https://www.twilio.com/docs/errors/21608",
  status: 400,
  account_sid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
});

describe("TwilioSmsProvider failure redaction (SEC-061)", () => {
  test("a failed send throws a generic SmsDeliveryError and discards the provider body", async () => {
    globalThis.fetch = (async () =>
      new Response(TWILIO_ERROR_BODY, {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const warnings: string[] = [];
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      warnings.push([message, ...rest].join(" "));
    };

    const failure = await PROVIDER.send(
      "+14155550999",
      "Your code is 123456",
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SmsDeliveryError);
    expect((failure as Error).message).toBe("SMS delivery failed");
    // No provider-body bytes in the thrown error…
    expect((failure as Error).message).not.toContain("21608");
    expect((failure as Error).message).not.toContain("+14155550999");
    expect((failure as Error).message).not.toContain("unverified");
    expect((failure as Error).stack ?? "").not.toContain("21608");

    // …nor in the server-side log line, which may carry the status code only.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("400");
    expect(warnings[0]).not.toContain("21608");
    expect(warnings[0]).not.toContain("+14155550999");
    expect(warnings[0]).not.toContain("unverified");
    expect(warnings[0]).not.toContain("ACxxxxxxxx");
  });

  test("a successful send resolves without logging", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ sid: "SMxxxxxxxx" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const warnings: string[] = [];
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      warnings.push([message, ...rest].join(" "));
    };

    await expect(
      PROVIDER.send("+14155550999", "Your code is 123456"),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(0);
  });
});

describe("TwilioVerifyProvider", () => {
  test("starts an SMS verification without handling the OTP body locally", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const createdAt = new Date(Date.now() - 1000);
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(
        JSON.stringify({
          status: "pending",
          date_created: createdAt.toISOString(),
        }),
        { status: 201 },
      );
    }) as typeof fetch;

    const delivery = await VERIFY_PROVIDER.send("+14155550999", "sms");

    expect(requestUrl).toBe(
      `https://verify.twilio.com/v2/Services/${VERIFY_SERVICE_SID}/Verifications`,
    );
    const body = new URLSearchParams(String(requestInit?.body));
    expect(body.get("To")).toBe("+14155550999");
    expect(body.get("Channel")).toBe("sms");
    expect(body.has("Body")).toBe(false);
    expect(body.has("From")).toBe(false);
    expect(delivery.expiresAt.getTime()).toBe(
      createdAt.getTime() + 10 * 60 * 1000,
    );
    expect(VERIFY_PROVIDER.challengeTtlMs).toBe(10 * 60 * 1000);
    expect(VERIFY_PROVIDER.operationLockTtlMs).toBe(20 * 1000);
    expect(VERIFY_PROVIDER.reservationTtlMs).toBe(10 * 60 * 1000 + 40 * 1000);
  });

  test("starts a WhatsApp verification on the requested channel", async () => {
    let requestInit: RequestInit | undefined;
    const createdAt = new Date(Date.now() - 1000);
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestInit = init;
      return new Response(
        JSON.stringify({
          status: "pending",
          date_created: createdAt.toISOString(),
        }),
        { status: 201 },
      );
    }) as typeof fetch;

    await VERIFY_PROVIDER.send("+14155550999", "whatsapp");

    const body = new URLSearchParams(String(requestInit?.body));
    expect(body.get("To")).toBe("+14155550999");
    expect(body.get("Channel")).toBe("whatsapp");
  });

  test("uses the authoritative status even when the deprecated valid field is absent", async () => {
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = new URLSearchParams(String(init?.body));
      const approved = body.get("Code") === "123456";
      return new Response(
        JSON.stringify({ status: approved ? "approved" : "pending" }),
        {
          status: 200,
        },
      );
    }) as typeof fetch;

    await expect(
      VERIFY_PROVIDER.verify("+14155550999", "123456"),
    ).resolves.toBe(true);
    await expect(
      VERIFY_PROVIDER.verify("+14155550999", "000000"),
    ).resolves.toBe(false);
  });

  test("preserves the original authoritative expiry on a resend", async () => {
    const createdAt = new Date(Date.now() - 1000);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "pending",
          date_created: createdAt.toISOString(),
        }),
        {
          status: 201,
        },
      )) as typeof fetch;

    const first = await VERIFY_PROVIDER.send("+14155550999", "sms");
    const resent = await VERIFY_PROVIDER.send("+14155550999", "sms");
    expect(resent.expiresAt).toEqual(first.expiresAt);
    expect(first.expiresAt.getTime()).toBe(
      createdAt.getTime() + 10 * 60 * 1000,
    );
  });

  test.each([
    { tokenTtlSeconds: 120, expectedMs: 120_000 },
    { tokenTtlSeconds: 86_400, expectedMs: 86_400_000 },
  ])(
    "accepts a configured Verify TTL of $tokenTtlSeconds seconds",
    ({ tokenTtlSeconds, expectedMs }) => {
      const provider = new TwilioVerifyProvider({
        accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        authToken: "twilio-auth-token",
        serviceSid: VERIFY_SERVICE_SID,
        tokenTtlSeconds,
      });
      expect(provider.challengeTtlMs).toBe(expectedMs);
    },
  );

  test.each([Number.NaN, 119, 86_401, 600.5])(
    "rejects a missing or invalid configured Verify TTL (%s)",
    (tokenTtlSeconds) => {
      expect(
        () =>
          new TwilioVerifyProvider({
            accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            authToken: "twilio-auth-token",
            serviceSid: VERIFY_SERVICE_SID,
            tokenTtlSeconds,
          }),
      ).toThrow("between 120 and 86400");
    },
  );

  test.each([-10 * 60 * 1000 - 1, 60 * 1000])(
    "rejects an expired or implausibly future challenge timestamp",
    async (createdAtOffsetMs) => {
      const createdAt = new Date(Date.now() + createdAtOffsetMs);
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            status: "pending",
            date_created: createdAt.toISOString(),
          }),
          {
            status: 201,
          },
        )) as typeof fetch;

      await expect(VERIFY_PROVIDER.send("+14155550999", "sms")).rejects.toThrow(
        SmsDeliveryError,
      );
    },
  );

  test("treats a missing or expired verification as an invalid code", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 20404, message: "not found" }), {
        status: 404,
      })) as typeof fetch;

    await expect(
      VERIFY_PROVIDER.verify("+14155550999", "123456"),
    ).resolves.toBe(false);
  });

  test("redacts Verify send and check provider failures", async () => {
    const warnings: string[] = [];
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      warnings.push([message, ...rest].join(" "));
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const isCheck = String(input).endsWith("/VerificationCheck");
      return new Response(TWILIO_ERROR_BODY, { status: isCheck ? 503 : 400 });
    }) as typeof fetch;

    const sendFailure = await VERIFY_PROVIDER.send("+14155550999", "sms").then(
      () => null,
      (error: unknown) => error,
    );
    const checkFailure = await VERIFY_PROVIDER.verify(
      "+14155550999",
      "123456",
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(sendFailure).toBeInstanceOf(SmsDeliveryError);
    expect(checkFailure).toBeInstanceOf(SmsVerificationError);
    expect(warnings.length).toBeGreaterThan(0);
    for (const value of [
      (sendFailure as Error).message,
      (checkFailure as Error).message,
      ...warnings,
    ]) {
      expect(value).not.toContain("21608");
      expect(value).not.toContain("+14155550999");
      expect(value).not.toContain("unverified");
      expect(value).not.toContain("ACxxxxxxxx");
    }
  });

  test("maps transport failures to generic redacted provider errors", async () => {
    const warnings: string[] = [];
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      warnings.push([message, ...rest].join(" "));
    };
    globalThis.fetch = (async () => {
      throw new Error("socket failed for +14155550999 with twilio-auth-token");
    }) as typeof fetch;

    await expect(VERIFY_PROVIDER.send("+14155550999", "sms")).rejects.toThrow(
      SmsDeliveryError,
    );
    await expect(
      VERIFY_PROVIDER.verify("+14155550999", "123456"),
    ).rejects.toThrow(SmsVerificationError);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join("\n")).not.toContain("+14155550999");
    expect(warnings.join("\n")).not.toContain("twilio-auth-token");
  });

  test("bounds a stalled Verify request and keeps the failure generic", async () => {
    const provider = new TwilioVerifyProvider({
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      serviceSid: VERIFY_SERVICE_SID,
      tokenTtlSeconds: 600,
      requestTimeoutMs: 5,
    });
    const warnings: string[] = [];
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      warnings.push([message, ...rest].join(" "));
    };
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing request signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      })) as typeof fetch;

    await expect(provider.send("+14155550999", "sms")).rejects.toThrow(
      SmsDeliveryError,
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(provider.operationLockTtlMs).toBe(5 * 1000 + 5);
    expect(provider.reservationTtlMs).toBe(
      provider.challengeTtlMs + 2 * provider.operationLockTtlMs,
    );
  });

  test("rejects a malformed Verify Service SID before any request", () => {
    expect(
      () =>
        new TwilioVerifyProvider({
          accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          authToken: "twilio-auth-token",
          serviceSid: "not-a-service-sid",
          tokenTtlSeconds: 600,
        }),
    ).toThrow("valid Verify Service SID");
  });

  test("rejects an unbounded Verify request timeout", () => {
    expect(
      () =>
        new TwilioVerifyProvider({
          accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          authToken: "twilio-auth-token",
          serviceSid: VERIFY_SERVICE_SID,
          tokenTtlSeconds: 600,
          requestTimeoutMs: 60_001,
        }),
    ).toThrow("between 1 and 60000");
  });
});
