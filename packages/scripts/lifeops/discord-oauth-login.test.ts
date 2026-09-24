/** Discord loopback OAuth protocol tests use injected responses and no network. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearDiscordOAuthLoginsForTest,
  completeDiscordOAuthCallback,
  markDiscordFlowSaved,
  pollDiscordOAuthLogin,
  startDiscordOAuthLogin,
} from "./discord-oauth-login.mjs";

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test.afterEach(() => clearDiscordOAuthLoginsForTest());

const REDIRECT = "http://127.0.0.1:43117/oauth/discord/callback";

function start(overrides = {}) {
  return startDiscordOAuthLogin({
    clientId: "client-123",
    redirectUri: REDIRECT,
    target: "home",
    ...overrides,
  });
}

function extractState(authorizeUrl) {
  return new URL(authorizeUrl).searchParams.get("state");
}

test("start requires owner setup and a loopback redirect", () => {
  assert.throws(() => start({ clientId: "" }), /needs owner setup/);
  assert.throws(() => start({ redirectUri: "not-a-url" }), /redirect URI/);
  assert.throws(() => start({ target: "elsewhere" }), /target must be/);
});

test("start builds an identify-scoped authorize URL with CSRF state", () => {
  const flow = start();
  const url = new URL(flow.authorizeUrl);
  assert.equal(
    url.origin + url.pathname,
    "https://discord.com/oauth2/authorize",
  );
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(url.searchParams.get("scope"), "identify");
  assert.ok((url.searchParams.get("state") ?? "").length >= 24);
  assert.equal(flow.redirectUri, REDIRECT);
});

test("callback exchanges the code server-side and hands the token over once", async () => {
  const flow = start();
  const calls = [];
  const result = await completeDiscordOAuthCallback({
    state: extractState(flow.authorizeUrl),
    code: "auth-code-1",
    clientSecret: "secret-1",
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      if (url === "https://discord.com/api/oauth2/token") {
        const body = new URLSearchParams(init.body);
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("code"), "auth-code-1");
        assert.equal(body.get("client_secret"), "secret-1");
        assert.equal(body.get("redirect_uri"), REDIRECT);
        return response({ access_token: "user-token-xyz" });
      }
      assert.equal(url, "https://discord.com/api/v10/users/@me");
      assert.equal(init.headers.Authorization, "Bearer user-token-xyz");
      return response({ username: "shaw" });
    },
  });
  assert.equal(result.outcome, "complete");
  assert.equal(result.token, "user-token-xyz");
  assert.equal(result.username, "shaw");
  assert.equal(result.target, "home");
  assert.equal(calls.length, 2);

  // Until the caller reports the persisted result, polls stay pending and
  // never expose the token.
  const pending = pollDiscordOAuthLogin({ flowId: result.flowId });
  assert.equal(pending.status, "pending");
  assert.equal(JSON.stringify(pending).includes("user-token-xyz"), false);

  markDiscordFlowSaved(result.flowId, {
    masked: "…-wxyz",
    key: "DISCORD_USER_OAUTH_TOKEN",
    target: "home",
  });
  const complete = pollDiscordOAuthLogin({ flowId: result.flowId });
  assert.equal(complete.status, "complete");
  assert.equal(complete.masked, "…-wxyz");
  assert.equal(complete.username, "shaw");
  assert.equal(JSON.stringify(complete).includes("user-token-xyz"), false);
  // Completed flows are single-read.
  assert.equal(
    pollDiscordOAuthLogin({ flowId: result.flowId }).status,
    "expired",
  );
});

test("a denial on Discord becomes a typed denied outcome", async () => {
  const flow = start();
  const result = await completeDiscordOAuthCallback({
    state: extractState(flow.authorizeUrl),
    code: "",
    providerError: "access_denied",
    clientSecret: "secret-1",
    fetchFn: async () => {
      throw new Error("network must not be touched on denial");
    },
  });
  assert.equal(result.outcome, "denied");
  const polled = pollDiscordOAuthLogin({ flowId: flow.flowId });
  assert.equal(polled.status, "denied");
  assert.match(polled.detail, /denied on Discord/);
});

test("an unknown or replayed state is rejected without touching the network", async () => {
  start();
  const result = await completeDiscordOAuthCallback({
    state: "forged-state-value",
    code: "auth-code",
    clientSecret: "secret-1",
    fetchFn: async () => {
      throw new Error("network must not be touched for unknown state");
    },
  });
  assert.equal(result.outcome, "unknown-state");
});

test("a failed exchange becomes a typed error outcome the poll reports", async () => {
  const flow = start();
  const result = await completeDiscordOAuthCallback({
    state: extractState(flow.authorizeUrl),
    code: "bad-code",
    clientSecret: "secret-1",
    fetchFn: async () => response({ error: "invalid_grant" }, 400),
  });
  assert.equal(result.outcome, "error");
  assert.match(result.detail, /invalid_grant|HTTP 400/);
  const polled = pollDiscordOAuthLogin({ flowId: flow.flowId });
  assert.equal(polled.status, "error");
  assert.match(polled.detail, /invalid_grant|HTTP 400/);
});

test("a missing client secret fails closed before any exchange", async () => {
  const flow = start();
  const result = await completeDiscordOAuthCallback({
    state: extractState(flow.authorizeUrl),
    code: "auth-code",
    clientSecret: "",
    fetchFn: async () => {
      throw new Error("network must not be touched without a secret");
    },
  });
  assert.equal(result.outcome, "error");
  assert.match(result.detail, /DISCORD_CLIENT_SECRET/);
});

test("flows expire after their TTL", () => {
  let nowMs = 1_000;
  const flow = startDiscordOAuthLogin({
    clientId: "client-123",
    redirectUri: REDIRECT,
    target: "repo",
    now: () => nowMs,
  });
  nowMs += 10 * 60 * 1_000 + 1;
  const polled = pollDiscordOAuthLogin({
    flowId: flow.flowId,
    now: () => nowMs,
  });
  assert.equal(polled.status, "expired");
});
