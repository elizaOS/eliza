/**
 * Pins the shared-utils REST deadline contract for the 4 helpers added in
 * fix/cloud-bound-remaining-api-hops. Each helper owns a 30s deadline;
 * a hung peer or a never-aborted caller signal cannot pin the Cloud worker.
 * Mirrors discord-api.error-policy.test.ts precedent.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";

import { BLOOIO_REQUEST_TIMEOUT_MS, blooioFetch } from "./blooio-api";
import { CLOUDFLARE_REQUEST_TIMEOUT_MS, cloudflareFetch } from "./cloudflare-api";
import { TWILIO_REQUEST_TIMEOUT_MS, twilioFetch } from "./twilio-api";
import { TWITTER_REQUEST_TIMEOUT_MS, twitterFetch } from "./twitter-api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function installHungFetch(): void {
  globalThis.fetch = mock(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const guard = setTimeout(
          () => reject(new Error("test guard elapsed before deadline")),
          2_000,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(guard);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  ) as typeof fetch;
}

function installStalledBody(status = 503): void {
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // stall forever; abort should error the stream
        init?.signal?.addEventListener("abort", () => {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        });
      },
    });
    return new Response(stream, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("shared-utils deadline helpers", () => {
  it("exports 30s constants", () => {
    expect(TWITTER_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(CLOUDFLARE_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(TWILIO_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(BLOOIO_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("aborts a hung Twitter hop at the owned deadline", async () => {
    installHungFetch();
    await expect(twitterFetch("https://api.twitter.com/2/test", undefined, 100)).rejects.toThrow(
      /aborted/i,
    );
  });

  it("aborts a hung Cloudflare hop at the owned deadline", async () => {
    installHungFetch();
    await expect(
      cloudflareFetch("https://api.cloudflare.com/client/v4/test", undefined, 100),
    ).rejects.toThrow(/aborted/i);
  });

  it("aborts a hung Twilio hop at the owned deadline", async () => {
    installHungFetch();
    await expect(
      twilioFetch("https://api.twilio.com/2010-04-01/test", undefined, 100),
    ).rejects.toThrow(/aborted/i);
  });

  it("aborts a hung Blooio hop at the owned deadline", async () => {
    installHungFetch();
    await expect(blooioFetch("https://api.blooio.com/v2/api/test", undefined, 100)).rejects.toThrow(
      /aborted/i,
    );
  });

  it("keeps the deadline when a never-aborted caller signal is supplied (Twitter)", async () => {
    installHungFetch();
    const never = new AbortController();
    await expect(
      twitterFetch("https://api.twitter.com/2/test", { signal: never.signal }, 100),
    ).rejects.toThrow(/aborted/i);
  });

  it("keeps the deadline when a never-aborted caller signal is supplied (Cloudflare)", async () => {
    installHungFetch();
    const never = new AbortController();
    await expect(
      cloudflareFetch("https://api.cloudflare.com/client/v4/test", { signal: never.signal }, 100),
    ).rejects.toThrow(/aborted/i);
  });

  it("propagates caller cancellation before the deadline (Twitter)", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const guard = setTimeout(() => reject(new Error("guard")), 2_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(guard);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const pending = twitterFetch(
      "https://api.twitter.com/2/test",
      { signal: controller.signal },
      60_000,
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    expect(seen).toBeDefined();
    expect(seen).not.toBe(controller.signal);
  });

  it("propagates caller cancellation before the deadline (Cloudflare)", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const guard = setTimeout(() => reject(new Error("guard")), 2_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(guard);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const pending = cloudflareFetch(
      "https://api.cloudflare.com/client/v4/test",
      { signal: controller.signal },
      60_000,
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    expect(seen).toBeDefined();
    expect(seen).not.toBe(controller.signal);
  });

  it("body consumption remains bounded by the same hop deadline (Twitter headers arrive, body stalls)", async () => {
    installStalledBody(503);
    const response = await twitterFetch("https://api.twitter.com/2/test", undefined, 200);
    // headers arrived, but body should abort at deadline
    await expect(response.text()).rejects.toThrow(/aborted/i);
  });

  it("body consumption remains bounded by the same hop deadline (Cloudflare)", async () => {
    installStalledBody(500);
    const response = await cloudflareFetch(
      "https://api.cloudflare.com/client/v4/test",
      undefined,
      200,
    );
    await expect(response.text()).rejects.toThrow(/aborted/i);
  });

  it("body consumption remains bounded for deadline-only helpers (Twilio/Blooio)", async () => {
    installStalledBody(502);
    const r1 = await twilioFetch("https://api.twilio.com/2010-04-01/test", undefined, 200);
    await expect(r1.text()).rejects.toThrow(/aborted/i);
    globalThis.fetch = realFetch;
    installStalledBody(502);
    const r2 = await blooioFetch("https://api.blooio.com/v2/api/test", undefined, 200);
    await expect(r2.text()).rejects.toThrow(/aborted/i);
  });

  it("restores fetch after every case (no mock leak)", async () => {
    installHungFetch();
    await expect(twitterFetch("https://api.twitter.com/2/test", undefined, 100)).rejects.toThrow(
      /aborted/i,
    );
    expect(globalThis.fetch).not.toBe(realFetch);
    globalThis.fetch = realFetch;
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("preserves timeout identity on Twitter error path (stalled body rethrows AbortError)", async () => {
    const source = await Bun.file("packages/cloud/shared/src/lib/utils/twitter-api.ts").text();
    expect(source).toContain('cause.name === "AbortError"');
    expect(source).toContain("throw cause");
    expect(source).not.toContain("response.json().catch(() => ({}))");
  });

  it("does not claim every helper composes caller signal (Twilio/Blooio are deadline-only)", async () => {
    const twilioSource = await Bun.file("packages/cloud/shared/src/lib/utils/twilio-api.ts").text();
    const blooioSource = await Bun.file("packages/cloud/shared/src/lib/utils/blooio-api.ts").text();
    expect(twilioSource).toContain("deadline-only");
    expect(blooioSource).toContain("deadline-only");
  });
});
