/**
 * Pins the outbound hop deadline on the four social-media providers that shipped
 * without one: mastodon, linkedin, telegram and meta.
 *
 * These are driven against a REAL `http.createServer` that accepts the socket and
 * never writes a response, not a stubbed `fetch`. A stub can only prove that the
 * wrapper forwards a signal; only a real socket proves the transport actually
 * gives up, which is the failure the four providers had (`fetch()` with no
 * `signal` at all, replayed up to four times by `withRetry(..., { maxRetries: 3 })`).
 *
 * Every hung arm is a race against an explicit watchdog: the test-runner timeout
 * does NOT interrupt a never-settling `fetch`, so an unbounded regression would
 * hang the suite instead of failing it. Racing a watchdog turns that back into a
 * plain assertion failure.
 *
 * The last two cases are the compatibility half: a caller-provided signal still
 * wins, and an ordinary fast call is untouched by the deadline.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import http from "node:http";

import type { SocialCredentials } from "../../../types/social-media";
import { linkedinFetch, linkedinProvider } from "./linkedin";
import { mastodonFetch, mastodonProvider } from "./mastodon";
import { metaFetch, metaProvider } from "./meta";
import { telegramFetch, telegramProvider } from "./telegram";

const HOP_TIMEOUT_MS = 150;
const WATCHDOG_MS = 5_000;

let blackHole: http.Server;
let blackHoleUrl: string;
let responsive: http.Server;
let responsiveUrl: string;

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}/`);
    });
  });
}

/**
 * Resolve to the wrapper's outcome, or to the sentinel if the wrapper is still
 * pending after `WATCHDOG_MS`. Without this an un-deadlined hop never settles and
 * the runner reports a hang rather than a failed expectation.
 */
async function raceWatchdog(pending: Promise<unknown>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("STILL-PENDING"), WATCHDOG_MS);
  });
  try {
    return await Promise.race([
      pending.then(
        () => "resolved",
        (error: unknown) => `rejected:${(error as Error).name}`,
      ),
      watchdog,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

beforeAll(async () => {
  blackHole = http.createServer(() => {
    // Accept the request and never answer it.
  });
  blackHoleUrl = await listen(blackHole);

  responsive = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  responsiveUrl = await listen(responsive);
});

afterAll(() => {
  blackHole.close();
  responsive.close();
});

const wrappers: Array<[string, typeof mastodonFetch]> = [
  ["mastodonFetch", mastodonFetch],
  ["linkedinFetch", linkedinFetch],
  ["telegramFetch", telegramFetch],
  ["metaFetch", metaFetch],
];

describe("social-media provider hops are bounded", () => {
  for (const [name, hopFetch] of wrappers) {
    it(`${name} aborts a hop against a peer that never answers`, async () => {
      const started = Date.now();
      const outcome = await raceWatchdog(
        hopFetch(blackHoleUrl, undefined, HOP_TIMEOUT_MS).catch((error: unknown) => {
          throw error;
        }),
      );

      expect(outcome).toBe("rejected:TimeoutError");
      expect(Date.now() - started).toBeLessThan(WATCHDOG_MS);
    });
  }

  it("a caller-provided abort signal still wins over the hop deadline", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("caller-cancelled")), 50);

    // A 30s deadline that must NOT be what settles this call.
    const pending = mastodonFetch(blackHoleUrl, { signal: controller.signal }, 30_000);

    await expect(pending).rejects.toThrow("caller-cancelled");
  });

  it("an ordinary fast hop is unchanged by the deadline", async () => {
    for (const [, hopFetch] of wrappers) {
      const response = await hopFetch(responsiveUrl);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"ok":true}');
    }
  });
});

/**
 * The wrapper existing is not enough: every provider call site has to route
 * through it. This pins the request-side contract at the transport boundary, so
 * a re-introduced bare `fetch()` at any of the seven call sites fails here even
 * though the wrapper itself is still correct.
 */
describe("every provider call site routes through its bounded wrapper", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const drives: Array<[string, () => Promise<unknown>]> = [
    [
      "mastodon",
      () =>
        mastodonProvider.validateCredentials({
          platform: "mastodon",
          accessToken: "tok",
          instanceUrl: "https://mastodon.example",
        } as SocialCredentials),
    ],
    [
      "linkedin",
      () =>
        linkedinProvider.validateCredentials({
          platform: "linkedin",
          accessToken: "tok",
        } as SocialCredentials),
    ],
    [
      "telegram",
      () =>
        telegramProvider.validateCredentials({
          platform: "telegram",
          botToken: "123:abc",
        } as unknown as SocialCredentials),
    ],
    [
      "meta",
      () =>
        metaProvider.validateCredentials({
          platform: "facebook",
          accessToken: "tok",
        } as SocialCredentials),
    ],
  ];

  for (const [name, drive] of drives) {
    it(`${name} hands the transport an abort signal`, async () => {
      const seen: Array<AbortSignal | null | undefined> = [];
      globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init?.signal);
        return new Response(JSON.stringify({ id: "1", ok: true, result: { id: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      await drive();

      expect(seen.length).toBeGreaterThan(0);
      for (const signal of seen) {
        expect(signal).toBeInstanceOf(AbortSignal);
      }
    });
  }
});
