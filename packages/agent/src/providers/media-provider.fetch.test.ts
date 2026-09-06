/**
 * `fetchWithTimeout` — the shared network primitive behind every media
 * provider in this file (twenty-plus call sites), and previously untested.
 *
 * Deterministic: every case talks to a local HTTP server on an ephemeral port,
 * the same approach `api/server-helpers-fetch.test.ts` uses for the sibling
 * `fetchWithTimeoutGuard`. No stubbed `fetch`, no network.
 */

import { getEventListeners } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMediaProviders, fetchWithTimeout } from "./media-provider";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/` };
}

/** A server that never answers, so only an abort can end the request. */
function neverResponds(): Promise<{ url: string }> {
  return listen((req, res) => {
    const handle = setTimeout(() => res.end("late"), 30_000);
    req.on("close", () => clearTimeout(handle));
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

describe("fetchWithTimeout", () => {
  it("returns the response and passes method, headers and body through", async () => {
    let seenMethod: string | undefined;
    let seenHeader: string | undefined;
    let seenBody = "";
    const { url } = await listen((req, res) => {
      seenMethod = req.method;
      seenHeader = req.headers["x-provider-key"] as string | undefined;
      req.on("data", (chunk) => {
        seenBody += String(chunk);
      });
      req.on("end", () => res.end("ok"));
    });

    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "x-provider-key": "secret" },
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(response.ok).toBe(true);
    expect(await response.text()).toBe("ok");
    expect(seenMethod).toBe("POST");
    expect(seenHeader).toBe("secret");
    expect(JSON.parse(seenBody)).toEqual({ prompt: "a cat" });
  });

  it("does not treat a non-2xx response as a failure", async () => {
    // The providers check `response.ok` themselves and read the error body;
    // rejecting here would hide their messages behind a generic network error.
    const { url } = await listen((_req, res) => {
      res.statusCode = 429;
      res.end("rate limited");
    });

    const response = await fetchWithTimeout(url, { method: "GET" });
    expect(response.ok).toBe(false);
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("rate limited");
  });

  it("aborts once timeoutMs elapses", async () => {
    const { url } = await listen((req, res) => {
      const handle = setTimeout(() => res.end("late"), 5_000);
      req.on("close", () => clearTimeout(handle));
    });

    await expect(
      fetchWithTimeout(url, { method: "GET" }, 40),
    ).rejects.toSatisfy(isAbort);
  });

  it("does not abort a request that finishes inside the timeout", async () => {
    const { url } = await listen((_req, res) => res.end("fast"));
    const response = await fetchWithTimeout(url, { method: "GET" }, 5_000);
    expect(await response.text()).toBe("fast");
  });

  it("clears its timer on success, leaving no pending handle", async () => {
    // A leaked timer keeps the event loop alive for the full timeout and, in a
    // long-lived agent, accumulates one handle per provider call.
    const { url } = await listen((_req, res) => res.end("ok"));
    const before = process.getActiveResourcesInfo?.().length ?? 0;
    await fetchWithTimeout(url, { method: "GET" }, 60_000);
    const after = process.getActiveResourcesInfo?.().length ?? 0;
    expect(after).toBeLessThanOrEqual(before);
  });

  it("clears its timer when the request FAILS, not only when it succeeds", async () => {
    // `.finally` rather than `.then` is what makes this true.
    const before = process.getActiveResourcesInfo?.().length ?? 0;
    await expect(
      fetchWithTimeout("http://127.0.0.1:1/", { method: "GET" }, 60_000),
    ).rejects.toThrow();
    const after = process.getActiveResourcesInfo?.().length ?? 0;
    expect(after).toBeLessThanOrEqual(before);
  });

  it("honours a caller signal that is ALREADY aborted, without opening a request", async () => {
    let reached = false;
    const { url } = await listen((_req, res) => {
      reached = true;
      res.end("should not happen");
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchWithTimeout(
        url,
        { method: "GET", signal: controller.signal },
        60_000,
      ),
    ).rejects.toSatisfy(isAbort);
    expect(reached).toBe(false);
  });

  it("honours a caller signal aborted MID-FLIGHT", async () => {
    // Without chaining, replacing `init.signal` silently drops cancellation and
    // the caller waits out the whole timeout instead.
    const { url } = await neverResponds();
    const controller = new AbortController();
    const pending = fetchWithTimeout(
      url,
      { method: "GET", signal: controller.signal },
      60_000,
    );
    queueMicrotask(() => controller.abort());

    await expect(pending).rejects.toSatisfy(isAbort);
  });

  it("cancels well before the timeout would have fired", async () => {
    // Proves the abort came from the caller, not from the timer.
    const { url } = await neverResponds();
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = fetchWithTimeout(
      url,
      { method: "GET", signal: controller.signal },
      30_000,
    );
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toSatisfy(isAbort);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("still times out normally when a caller signal is supplied but never fires", async () => {
    const { url } = await neverResponds();
    const controller = new AbortController();

    await expect(
      fetchWithTimeout(url, { method: "GET", signal: controller.signal }, 40),
    ).rejects.toSatisfy(isAbort);
  });

  it("removes its abort listener, so a reused caller signal does not accumulate them", async () => {
    // `{ once: true }` only self-removes on a listener that actually FIRES.
    // A signal reused across many provider calls — the normal case for a
    // per-request cancellation token — would otherwise grow one dead listener
    // per completed call.
    const { url } = await listen((_req, res) => res.end("ok"));
    const controller = new AbortController();

    for (let index = 0; index < 5; index += 1) {
      await fetchWithTimeout(
        url,
        { method: "GET", signal: controller.signal },
        60_000,
      );
    }

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(() => controller.abort()).not.toThrow();
  });
});

describe("createMediaProviders", () => {
  it("is fail-fast: an unusable image slot aborts the whole bundle", () => {
    // The four factories are evaluated eagerly inside one object literal, so
    // the bundle is all-or-nothing rather than partially populated. Worth
    // pinning because a caller cannot rely on reading `.audio` off a result
    // whose `.image` could not be built.
    expect(() =>
      createMediaProviders(undefined, { cloudMediaDisabled: true }),
    ).toThrow(/No image provider configured and cloud media is disabled/);
  });

  it("surfaces the cloud-mode guidance when cloud media is enabled", () => {
    expect(() =>
      createMediaProviders(undefined, {
        cloudMediaDisabled: false,
        elizaCloudApiKey: "eliza_cloud_key",
        elizaCloudBaseUrl: "https://api.elizacloud.ai/api/v1",
      }),
    ).toThrow(/ModelType\.IMAGE/);
  });

  it("reports the IMAGE slot first, so its message is the one an operator sees", () => {
    // Image is constructed before video, audio and vision. If that order ever
    // changes, an operator debugging a missing image config would be handed a
    // video error instead.
    try {
      createMediaProviders(undefined, { cloudMediaDisabled: true });
      expect.unreachable("expected the bundle to refuse");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("image provider");
      expect(message).not.toContain("video provider");
      expect(message).not.toContain("audio provider");
    }
  });
});
