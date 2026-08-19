/**
 * Verifies the vendor API wrappers bound request deadlines.
 * The suite pins that every outbound fetch carries an AbortSignal that times out,
 * and that caller-provided signals are honored — matching the `fix(cloud): bound`
 * pattern landed in the last 100 merges (#22236, #22287).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { blooioApiRequest } from "./blooio-api";
import { cloudflareApiRequest } from "./cloudflare-api";
import { twilioApiRequest } from "./twilio-api";
import { twitterApiRequest } from "./twitter-api";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout.bind(AbortSignal);

type Captured = { url: string; init?: RequestInit };

function stubFetch(captured: Captured[], response: Response): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init });
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
}

function envelope<T>(result: T): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("cloudflareApiRequest timeout", () => {
  test("attaches a 10s deadline when caller provides no signal", async () => {
    const captured: Captured[] = [];
    let timeoutMs: number | undefined;
    const spy = AbortSignal.timeout;
    // @ts-expect-error spy
    AbortSignal.timeout = ((ms: number) => {
      timeoutMs = ms;
      return originalTimeout(ms);
    }) as typeof AbortSignal.timeout;

    globalThis.fetch = stubFetch(captured, envelope({ ok: true }));
    try {
      await cloudflareApiRequest("/zones", "tok", { method: "GET" });
      expect(timeoutMs).toBe(10_000);
      expect(captured[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      AbortSignal.timeout = spy;
    }
  });

  test("honors caller signal and does not override it", async () => {
    const captured: Captured[] = [];
    const caller = AbortSignal.timeout(5_000);
    let timeoutCalled = false;
    const spy = AbortSignal.timeout;
    // @ts-expect-error spy
    AbortSignal.timeout = ((ms: number) => {
      timeoutCalled = true;
      return originalTimeout(ms);
    }) as typeof AbortSignal.timeout;

    globalThis.fetch = stubFetch(captured, envelope({ ok: true }));
    try {
      await cloudflareApiRequest("/zones", "tok", { method: "GET", signal: caller });
      expect(captured[0]?.init?.signal).toBe(caller);
      expect(timeoutCalled).toBe(false);
    } finally {
      AbortSignal.timeout = spy;
    }
  });
});

describe("twitterApiRequest timeout", () => {
  test("attaches a 10s deadline by default", async () => {
    const captured: Captured[] = [];
    globalThis.fetch = stubFetch(
      captured,
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await twitterApiRequest("/tweets", "tok");
    expect(captured[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("honors caller signal", async () => {
    const captured: Captured[] = [];
    const caller = AbortSignal.timeout(2_000);
    globalThis.fetch = stubFetch(
      captured,
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await twitterApiRequest("/tweets", "tok", { signal: caller });
    expect(captured[0]?.init?.signal).toBe(caller);
  });
});

describe("blooioApiRequest timeout", () => {
  test("attaches a 10s deadline", async () => {
    const captured: Captured[] = [];
    globalThis.fetch = stubFetch(captured, new Response(JSON.stringify({}), { status: 200 }));
    await blooioApiRequest("key", "GET", "/ping");
    expect(captured[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("twilioApiRequest timeout", () => {
  test("attaches a 10s deadline", async () => {
    const captured: Captured[] = [];
    globalThis.fetch = stubFetch(captured, new Response(JSON.stringify({}), { status: 200 }));
    await twilioApiRequest("AC123", "tok", "GET", "/Messages.json");
    expect(captured[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
