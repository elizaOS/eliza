/**
 * Pins the outbound deadline on the three OAuth token-refresh hops that shipped
 * without one: `refreshMetaToken`, `refreshLinkedInToken` and `refreshTikTokToken`
 * in `token-refresh.ts`. The fourth arm of the same `refreshToken` switch
 * (twitter) already routes through `requestTwitterOAuth2Token`, which has carried
 * `AbortSignal.timeout(TWITTER_OAUTH2_TOKEN_TIMEOUT_MS)` since it was written --
 * the three hops here were the asymmetry.
 *
 * The hung arms are driven against a REAL `http.createServer` that accepts the
 * socket and never writes a response, not a stubbed `fetch`. A stub can only show
 * that a wrapper forwards a signal; only a real socket shows that the transport
 * actually gives up.
 *
 * Every hung arm is a race against an explicit watchdog: the test-runner timeout
 * does NOT interrupt a never-settling `fetch`, so an unbounded regression would
 * hang the suite instead of failing it. Racing a watchdog turns that back into a
 * plain assertion failure, and asserting the abort reason is specifically
 * `TimeoutError` means a "just drop the caller signal" non-fix fails too.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import http from "node:http";

import type { SocialCredentials } from "../../types/social-media";
import { refreshToken, tokenRefreshFetch } from "./token-refresh";

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
 * Resolve to the call's outcome, or to the sentinel if it is still pending after
 * `WATCHDOG_MS`. Without this an un-deadlined hop never settles and the runner
 * reports a hang rather than a failed expectation.
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

describe("tokenRefreshFetch bounds the OAuth refresh hop", () => {
  it("aborts a hop against a peer that never answers", async () => {
    const started = Date.now();
    const outcome = await raceWatchdog(tokenRefreshFetch(blackHoleUrl, undefined, HOP_TIMEOUT_MS));

    expect(outcome).toBe("rejected:TimeoutError");
    expect(Date.now() - started).toBeLessThan(WATCHDOG_MS);
  });

  it("lets a caller-provided abort signal win with its own reason", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("caller-cancelled")), 50);

    // A 30s deadline that must NOT be what settles this call.
    const pending = tokenRefreshFetch(blackHoleUrl, { signal: controller.signal }, 30_000);

    await expect(pending).rejects.toThrow("caller-cancelled");
  });

  it("still aborts at the deadline when the caller signal never fires", async () => {
    // Guards the `signal: init?.signal ?? deadline` non-fix: a request-scoped
    // controller that outlives the hop would silently restore the unbounded wait.
    const caller = new AbortController();
    const started = Date.now();

    const outcome = await raceWatchdog(
      tokenRefreshFetch(blackHoleUrl, { signal: caller.signal }, HOP_TIMEOUT_MS),
    );

    expect(outcome).toBe("rejected:TimeoutError");
    expect(caller.signal.aborted).toBe(false);
    expect(Date.now() - started).toBeLessThan(WATCHDOG_MS);
  });

  it("leaves an ordinary fast hop unchanged", async () => {
    const response = await tokenRefreshFetch(responsiveUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
  });
});

/**
 * The wrapper existing is not enough: each of the three refreshers has to route
 * through it. This pins the request-side contract at the transport boundary, so a
 * re-introduced bare `fetch()` in any of them fails here even though the wrapper
 * itself is still correct.
 */
describe("every token-refresh hop routes through the bounded wrapper", () => {
  const realFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.META_APP_ID = "app";
    process.env.META_APP_SECRET = "secret";
    process.env.LINKEDIN_CLIENT_ID = "cid";
    process.env.LINKEDIN_CLIENT_SECRET = "csecret";
    process.env.TIKTOK_CLIENT_KEY = "ckey";
    process.env.TIKTOK_CLIENT_SECRET = "csecret";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const drives: Array<[string, () => Promise<unknown>]> = [
    [
      "meta (facebook/instagram)",
      () =>
        refreshToken("facebook", {
          platform: "facebook",
          accessToken: "tok",
        } as SocialCredentials),
    ],
    [
      "linkedin",
      () =>
        refreshToken("linkedin", {
          platform: "linkedin",
          accessToken: "tok",
          refreshToken: "rtok",
        } as SocialCredentials),
    ],
    [
      "tiktok",
      () =>
        refreshToken("tiktok", {
          platform: "tiktok",
          accessToken: "tok",
          refreshToken: "rtok",
        } as SocialCredentials),
    ],
  ];

  for (const [name, drive] of drives) {
    it(`${name} hands the transport an abort signal`, async () => {
      const seen: Array<AbortSignal | null | undefined> = [];
      globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init?.signal);
        return new Response(
          JSON.stringify({ access_token: "new", refresh_token: "new-r", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const result = await drive();

      expect(seen.length).toBeGreaterThan(0);
      for (const signal of seen) {
        expect(signal).toBeInstanceOf(AbortSignal);
      }
      // The refresh still returns its normal result: the deadline is additive.
      expect((result as { accessToken: string }).accessToken).toBe("new");
    });
  }
});
