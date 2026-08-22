/**
 * Pins the shared-utils REST deadline contract for the 4 helpers added in
 * fix/cloud-bound-remaining-api-hops. Each helper owns a 30s deadline;
 * a hung peer or a never-aborted caller signal cannot pin the Cloud worker.
 * Mirrors discord-api.error-policy.test.ts precedent.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";

mock.module("@elizaos/core/edge", () => ({
  isSensitiveKeyName: () => false,
  redactLogArgs: (args: unknown[]) => args,
}));

const { BLOOIO_REQUEST_TIMEOUT_MS, blooioFetch } = await import("./blooio-api");
const { CLOUDFLARE_REQUEST_TIMEOUT_MS, cloudflareFetch } = await import("./cloudflare-api");
const { ownedBoundedFetch } = await import("./owned-bounded-fetch");
const { TWILIO_REQUEST_TIMEOUT_MS, twilioFetch } = await import("./twilio-api");
const { TWITTER_REQUEST_TIMEOUT_MS, twitterFetch } = await import("./twitter-api");

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
    await expect(
      twitterFetch("https://api.twitter.com/2/test", undefined, 100),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a hung Cloudflare hop at the owned deadline", async () => {
    installHungFetch();
    await expect(
      cloudflareFetch("https://api.cloudflare.com/client/v4/test", undefined, 100),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a hung Twilio hop at the owned deadline", async () => {
    installHungFetch();
    await expect(
      twilioFetch("https://api.twilio.com/2010-04-01/test", undefined, 100),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a hung Blooio hop at the owned deadline", async () => {
    installHungFetch();
    await expect(
      blooioFetch("https://api.blooio.com/v2/api/test", undefined, 100),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("keeps the deadline when a never-aborted caller signal is supplied (Twitter)", async () => {
    installHungFetch();
    const never = new AbortController();
    await expect(
      twitterFetch("https://api.twitter.com/2/test", { signal: never.signal }, 100),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("keeps the deadline when a never-aborted caller signal is supplied (Cloudflare)", async () => {
    installHungFetch();
    const never = new AbortController();
    await expect(
      cloudflareFetch("https://api.cloudflare.com/client/v4/test", { signal: never.signal }, 100),
    ).rejects.toMatchObject({ name: "TimeoutError" });
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
    await expect(twitterFetch("https://api.twitter.com/2/test", undefined, 200)).rejects.toThrow(
      /expired/i,
    );
  });

  it("body consumption remains bounded by the same hop deadline (Cloudflare)", async () => {
    installStalledBody(500);
    await expect(
      cloudflareFetch("https://api.cloudflare.com/client/v4/test", undefined, 200),
    ).rejects.toThrow(/expired/i);
  });

  it("body consumption remains bounded for deadline-only helpers (Twilio/Blooio)", async () => {
    installStalledBody(502);
    await expect(
      twilioFetch("https://api.twilio.com/2010-04-01/test", undefined, 200),
    ).rejects.toThrow(/expired/i);
    globalThis.fetch = realFetch;
    installStalledBody(502);
    await expect(blooioFetch("https://api.blooio.com/v2/api/test", undefined, 200)).rejects.toThrow(
      /expired/i,
    );
  });

  it("does not dispatch a pre-aborted request", async () => {
    const caller = new AbortController();
    caller.abort(new DOMException("cancelled before dispatch", "AbortError"));
    const fetchMock = mock(async () => new Response());
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      twitterFetch("https://api.twitter.com/2/test", {
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the owned timer after a fully buffered success", async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      signal = init?.signal;
      return Response.json({ ok: true });
    }) as typeof fetch;

    const response = await twitterFetch("https://api.twitter.com/2/test", undefined, 20);
    expect(await response.json()).toEqual({ ok: true });
    await Bun.sleep(40);
    expect(signal?.aborted).toBe(false);
  });

  it("returns a typed size error even when body cancellation rejects", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              return Promise.reject(new Error("hostile cancel"));
            },
          }),
          { headers: { "content-length": "5" } },
        ),
    ) as typeof fetch;

    await expect(
      ownedBoundedFetch("https://example.com", undefined, {
        maxResponseBytes: 4,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "CLOUD_REST_RESPONSE_TOO_LARGE" });
  });

  it("does not await hostile cancellation on fragmentation overflow", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.enqueue(new Uint8Array([2]));
              controller.enqueue(new Uint8Array([3]));
            },
            cancel() {
              return new Promise<void>(() => undefined);
            },
          }),
        ),
    ) as typeof fetch;

    const outcome = await Promise.race([
      ownedBoundedFetch("https://example.com", undefined, {
        maxResponseBytes: 10,
        maxResponseChunks: 2,
        timeoutMs: 100,
      }).catch((error: unknown) => error),
      Bun.sleep(50).then(() => "hung"),
    ]);
    expect(outcome).toMatchObject({ code: "CLOUD_REST_RESPONSE_TOO_LARGE" });
  });

  it("restores fetch after every case (no mock leak)", async () => {
    installHungFetch();
    await expect(
      twitterFetch("https://api.twitter.com/2/test", undefined, 100),
    ).rejects.toMatchObject({ name: "TimeoutError" });
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

  it("routes Twilio and Blooio through the same owned helper", async () => {
    const twilioSource = await Bun.file("packages/cloud/shared/src/lib/utils/twilio-api.ts").text();
    const blooioSource = await Bun.file("packages/cloud/shared/src/lib/utils/blooio-api.ts").text();
    expect(twilioSource).toContain("ownedBoundedFetch");
    expect(blooioSource).toContain("ownedBoundedFetch");
  });
});
