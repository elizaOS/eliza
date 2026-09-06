/**
 * Regression tests for outbound recovery after a failed startup token probe
 * (#29751 review): a transient token failure must not permanently gate
 * `sendText`. Harness is deterministic — a real `WechatChannel.start() +
 * sendText()` path with an injected fetch implementation and injectable clock;
 * no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WechatChannel } from "./channel";
import type { WechatTransportHealth } from "./types";

function tokenOkBody(token = "tok-1", expiresIn = 7200) {
  return JSON.stringify({ access_token: token, expires_in: expiresIn });
}

function sendOkBody() {
  return JSON.stringify({ errcode: 0, errmsg: "ok" });
}

interface FetchState {
  calls: number;
  failTokens: boolean;
  failSends: boolean;
  tokenBody: string;
  sendBody: string;
}

/**
 * Start a real channel with one official-account account and an injectable
 * fetch implementation. Returns the channel plus the mutable fetch state so a
 * test can flip the platform between failing and healthy between calls.
 */
async function startChannel(fetch: FetchState) {
  let nowMs = 1_700_000_000_000;
  const channel = new WechatChannel({
    config: {
      callbackPort: 0,
      account: {
        mode: "official-account",
        appId: "wx-app",
        appSecret: "secret",
        token: "callback-token",
      },
    },
    onMessage: () => undefined,
    now: () => nowMs,
    fetchFn: (async (input: string | URL | Request) => {
      fetch.calls += 1;
      const url = String(input);
      const isTokenCall = url.includes("stable_token");
      const fail = isTokenCall ? fetch.failTokens : fetch.failSends;
      if (fail) {
        throw new Error("network down");
      }
      const body = isTokenCall ? fetch.tokenBody : fetch.sendBody;
      return new Response(body, { status: 200 });
    }) as unknown as typeof globalThis.fetch,
  });
  return {
    channel,
    fetch,
    advance: (ms: number) => {
      nowMs += ms;
    },
    health: (): WechatTransportHealth | undefined =>
      channel.getAccountHealth("default"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("outbound recovery after failed startup token probe", () => {
  it("marks outbound unavailable and throws typed error at startup failure", async () => {
    const handle = await startChannel({
      calls: 0,
      failTokens: true,
      failSends: false,
      tokenBody: tokenOkBody(),
      sendBody: sendOkBody(),
    });
    await handle.channel.start();
    expect(handle.health()?.state).toBe("unavailable");
    await expect(
      handle.channel.sendText("default", "openid-alice", "hi"),
    ).rejects.toMatchObject({ code: "WECHAT_ACCOUNT_UNAVAILABLE" });
    // One probe call only: the backoff window suppresses an immediate retry.
    expect(handle.fetch.calls).toBe(1);
    await handle.channel.stop();
  });

  it("recovers on the next send after the platform heals (transient failure)", async () => {
    const handle = await startChannel({
      calls: 0,
      failTokens: true,
      failSends: false,
      tokenBody: tokenOkBody(),
      sendBody: sendOkBody(),
    });
    await handle.channel.start();
    expect(handle.health()?.state).toBe("unavailable");

    // Inside the backoff window the send still fails closed without probing.
    await expect(
      handle.channel.sendText("default", "openid-alice", "hi"),
    ).rejects.toMatchObject({ code: "WECHAT_ACCOUNT_UNAVAILABLE" });
    expect(handle.fetch.calls).toBe(1);

    // Platform heals; after the backoff window the next send re-probes and
    // delivers instead of stranding outbound until restart.
    handle.fetch.failTokens = false;
    handle.advance(31_000);
    await expect(
      handle.channel.sendText("default", "openid-alice", "recovered"),
    ).resolves.toBeUndefined();
    expect(handle.health()?.state).toBe("connected");
    // probe retry + token fetch + send
    expect(handle.fetch.calls).toBe(3);
    await handle.channel.stop();
  });

  it("keeps failing closed with a fresh probe when the platform is still down", async () => {
    const handle = await startChannel({
      calls: 0,
      failTokens: true,
      failSends: false,
      tokenBody: tokenOkBody(),
      sendBody: sendOkBody(),
    });
    await handle.channel.start();
    handle.advance(31_000);
    await expect(
      handle.channel.sendText("default", "openid-alice", "hi"),
    ).rejects.toMatchObject({ code: "WECHAT_ACCOUNT_UNAVAILABLE" });
    // The recovery probe ran (and failed), restarting the backoff.
    expect(handle.fetch.calls).toBe(2);
    // An immediate second send is suppressed by the restarted backoff.
    await expect(
      handle.channel.sendText("default", "openid-alice", "hi"),
    ).rejects.toMatchObject({ code: "WECHAT_ACCOUNT_UNAVAILABLE" });
    expect(handle.fetch.calls).toBe(2);
    await handle.channel.stop();
  });
});
