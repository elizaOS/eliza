/**
 * NewsDataService RSS deadline and caller-cancellation contract tests.
 * The deterministic harness covers header and body stalls, signal composition,
 * wrapper forwarding, the public timeout budget, and successful RSS parsing.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NEWS_RSS_FETCH_TIMEOUT_MS,
  NewsDataService,
} from "./newsDataService";

function stallUntilAborted(signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function makeResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function stalledTextResponse(signal?: AbortSignal): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => stallUntilAborted(signal).then(() => ""),
    headers: new Headers(),
  } as unknown as Response;
}

function makeService(): NewsDataService {
  return new NewsDataService({} as IAgentRuntime);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NewsDataService RSS timeout", () => {
  it("exposes DEFAULT_NEWS_RSS_FETCH_TIMEOUT_MS === 10_000", () => {
    expect(DEFAULT_NEWS_RSS_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes AbortSignal.timeout budget to fetch (hanging fetch → TimeoutError)", async () => {
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((_ms: number) => origTimeout(10));

    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
      stallUntilAborted(init?.signal),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const svc = makeService();

    await expect(svc.getLatestNews()).rejects.toMatchObject({
      name: "TimeoutError",
    });

    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_NEWS_RSS_FETCH_TIMEOUT_MS);
    // Verify our mock was called with a signal (the timeout signal)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeDefined();
    expect(init.signal?.aborted).toBe(true);
  });

  it("aborts stalled response.text() body via same timeout signal", async () => {
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((_ms: number) =>
      origTimeout(10),
    );

    // Fetch returns headers quickly but body stalls — same signal must abort text()
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
      stalledTextResponse(init?.signal),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const svc = makeService();

    await expect(svc.getLatestNews()).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("merges caller signal via AbortSignal.any when provided", async () => {
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((_ms: number) => origTimeout(10));
    const anySpy = vi.spyOn(AbortSignal, "any");

    const callerCtrl = new AbortController();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
      stallUntilAborted(init?.signal),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const svc = makeService();
    const pending = svc.getLatestNews({ signal: callerCtrl.signal });

    // Abort via caller before timeout — should also reject with caller reason
    callerCtrl.abort(new DOMException("caller abort", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_NEWS_RSS_FETCH_TIMEOUT_MS);
    expect(anySpy).toHaveBeenCalled();
    const anyArgs = anySpy.mock.calls[0][0] as AbortSignal[];
    expect(anyArgs).toHaveLength(2);
    expect(anyArgs[0]).toBe(callerCtrl.signal);
  });

  it("forwards caller cancellation through every query wrapper", async () => {
    const svc = makeService();
    const signal = new AbortController().signal;
    const latestSpy = vi.spyOn(svc, "getLatestNews").mockResolvedValue([]);

    await svc.getTokenNews("BTC", { language: "en", limit: 2, signal });
    expect(latestSpy).toHaveBeenLastCalledWith({
      query: "btc",
      language: "en",
      limit: 2,
      signal,
    });

    await svc.getDefiNews({ language: "en", limit: 3, signal });
    expect(latestSpy).toHaveBeenLastCalledWith({
      query: "defi",
      language: "en",
      limit: 3,
      signal,
    });

    await svc.getCryptoMarketNews({ language: "en", limit: 4, signal });
    expect(latestSpy).toHaveBeenLastCalledWith({
      language: "en",
      limit: 4,
      signal,
    });
  });

  it("succeeds when fetch returns valid RSS within budget", async () => {
    const rss = `<?xml version="1.0"?><rss><channel><item><title>BTC up</title><link>https://example.test/a</link><description>hello</description><pubDate>Mon, 19 Aug 2026 00:00:00 GMT</pubDate><guid>guid-1</guid></item></channel></rss>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse(rss)));

    const svc = makeService();
    const articles = await svc.getLatestNews({ limit: 5 });

    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("BTC up");
    expect(articles[0].link).toBe("https://example.test/a");
  });
});
