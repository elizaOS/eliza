/**
 * Provider-spy coverage for the direct first-party transport: the token
 * manager must call exactly the official hosts with exactly the documented
 * shapes, cache until near expiry, single-flight concurrent refreshes,
 * report observational health, and reject with typed errors on credential
 * failure; the API client must send mode-correct bodies and recover exactly
 * once from an invalid-token error code. All fetch calls are spies; no
 * network is reachable.
 */
import { describe, expect, it, vi } from "vitest";
import { WechatApiClient } from "./api-client";
import { TokenManager } from "./token-manager";
import type { ResolvedWechatAccount } from "./types";

const OFFICIAL_ACCOUNT: ResolvedWechatAccount = {
  id: "main",
  mode: "official-account",
  platformAccountId: "wx1234",
  platformIdentity: "wx1234",
  secret: "app-secret",
  securityMode: "plaintext",
  tokenSecret: "cb-token",
  label: "OA",
};

const WECOM: ResolvedWechatAccount = {
  id: "corp",
  mode: "wecom",
  platformAccountId: "corp1_1000002",
  platformIdentity: "corp1",
  wecomAgentId: 1000002,
  secret: "corp-secret",
  securityMode: "encrypted",
  tokenSecret: "cb-token",
  encodingAESKey: "A".repeat(43),
  label: "WeCom",
};

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

describe("TokenManager provider spies", () => {
  it("calls the official-account stable_token endpoint with the documented body", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ access_token: "tok-1", expires_in: 7200 }),
    );
    const tokens = new TokenManager({ fetchFn, now: () => 1_000_000 });
    await tokens.getAccessToken(OFFICIAL_ACCOUNT);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.weixin.qq.com/cgi-bin/stable_token");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      grant_type: "client_credential",
      appid: "wx1234",
      secret: "app-secret",
      force_refresh: false,
    });
  });

  it("calls the wecom gettoken endpoint with corp credentials", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ access_token: "tok-c", expires_in: 7200 }),
    );
    const tokens = new TokenManager({ fetchFn, now: () => 1_000_000 });
    await tokens.getAccessToken(WECOM);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(
      "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=corp1&corpsecret=corp-secret",
    );
    expect(init.method).toBe("GET");
  });

  it("caches until near expiry and never re-fetches inside the window", async () => {
    let clock = 1_000_000;
    const fetchFn = vi.fn(async () =>
      jsonResponse({ access_token: "tok-1", expires_in: 7200 }),
    );
    const tokens = new TokenManager({ fetchFn, now: () => clock });
    await tokens.getAccessToken(OFFICIAL_ACCOUNT);
    clock += 60_000;
    await tokens.getAccessToken(OFFICIAL_ACCOUNT);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Past expires_in minus the refresh margin: refetch.
    clock += 7200_000;
    await tokens.getAccessToken(OFFICIAL_ACCOUNT);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent refreshes", async () => {
    let release: ((v: unknown) => void) | undefined;
    const fetchFn = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const tokens = new TokenManager({ fetchFn, now: () => 1_000_000 });
    const a = tokens.getAccessToken(OFFICIAL_ACCOUNT);
    const b = tokens.getAccessToken(OFFICIAL_ACCOUNT);
    release?.(jsonResponse({ access_token: "tok-1", expires_in: 7200 }));
    expect(await a).toBe("tok-1");
    expect(await b).toBe("tok-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("transitions health to unavailable on credential rejection and throws typed", async () => {
    const health: unknown[] = [];
    const fetchFn = vi.fn(async () =>
      jsonResponse({ errcode: 40001, errmsg: "invalid credential" }),
    );
    const tokens = new TokenManager({
      fetchFn,
      now: () => 1_000_000,
      onHealthChange: (_id, h) => health.push(h),
    });
    await expect(tokens.getAccessToken(OFFICIAL_ACCOUNT)).rejects.toMatchObject(
      { code: "WECHAT_TOKEN_UNAVAILABLE" },
    );
    expect(health).toEqual([
      expect.objectContaining({
        state: "unavailable",
        lastFailureDetail: "errcode-40001",
      }),
    ]);
  });

  it("never lets a request reach an arbitrary host", async () => {
    const fetchFn = vi.fn();
    const tokens = new TokenManager({ fetchFn, now: () => 1_000_000 });
    await tokens.getAccessToken(OFFICIAL_ACCOUNT).catch(() => undefined);
    await tokens.getAccessToken(WECOM).catch(() => undefined);
    for (const [url] of fetchFn.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/(api|qyapi)\.weixin\.qq\.com\//);
    }
  });
});

describe("WechatApiClient provider spies", () => {
  function makeTokens(token = "tok-1") {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ access_token: token, expires_in: 7200 }),
    );
    return {
      tokens: new TokenManager({ fetchFn, now: () => 1_000_000 }),
      fetchFn,
    };
  }

  it("sends official-account customer-service bodies", async () => {
    const { tokens } = makeTokens();
    const sendFetch = vi.fn(async () => jsonResponse({ errcode: 0 }));
    const api = new WechatApiClient({ tokens, fetchFn: sendFetch });
    const receipt = await api.sendText(OFFICIAL_ACCOUNT, "openid-alice", "hi");

    expect(receipt.ok).toBe(true);
    const [url, init] = sendFetch.mock.calls[0];
    expect(url).toBe(
      "https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=tok-1",
    );
    expect(JSON.parse(init.body)).toEqual({
      touser: "openid-alice",
      msgtype: "text",
      text: { content: "hi" },
    });
  });

  it("sends wecom app-message bodies with agentid", async () => {
    const { tokens } = makeTokens();
    const sendFetch = vi.fn(async () => jsonResponse({ errcode: 0 }));
    const api = new WechatApiClient({ tokens, fetchFn: sendFetch });
    await api.sendText(WECOM, "wecom-user", "hi");

    const [url, init] = sendFetch.mock.calls[0];
    expect(url).toBe(
      "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=tok-1",
    );
    expect(JSON.parse(init.body)).toEqual({
      touser: "wecom-user",
      msgtype: "text",
      agentid: 1000002,
      text: { content: "hi" },
    });
  });

  it("recovers exactly once from an invalid-token error code", async () => {
    const { tokens, fetchFn } = makeTokens("tok-stale");
    const sendFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ errcode: 42001, errmsg: "expired" }),
      )
      .mockResolvedValueOnce(jsonResponse({ errcode: 0 }));
    const api = new WechatApiClient({ tokens, fetchFn: sendFetch });

    const receipt = await api.sendText(OFFICIAL_ACCOUNT, "openid-alice", "hi");
    expect(receipt.ok).toBe(true);
    // One stale-token send, one recovery token fetch, one retry send.
    expect(sendFetch).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [retryUrl] = sendFetch.mock.calls[1];
    expect(retryUrl).toContain("access_token=tok-stale");
  });

  it("returns a redacted failed receipt on platform rejection", async () => {
    const { tokens } = makeTokens();
    const sendFetch = vi.fn(async () =>
      jsonResponse({
        errcode: 45002,
        errmsg: "message content is out of limit",
      }),
    );
    const api = new WechatApiClient({ tokens, fetchFn: sendFetch });
    const receipt = await api.sendText(OFFICIAL_ACCOUNT, "openid-alice", "hi");

    expect(receipt.ok).toBe(false);
    expect(receipt.platformErrorCode).toBe(45002);
    expect(receipt.redactedDetail).toBe("message content is out of limit");
  });
});
