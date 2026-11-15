import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  createNativeCloudAuth,
  SIGN_IN_CONFLICT,
} from "./cloud-enrollment.mjs";

const binding = Object.freeze({
  clientId: "org.example.native",
  environment: "test",
  redirectUri: "https://example.org/native/callback",
});
const RETURN = "http://127.0.0.1:31337/auth/google/return";
const AUTH = "https://auth.example.test";
const STEWARD_CODE = "steward-one-time-code-0123456789abcdef";
const SESSION = "private-steward-session-not-for-renderer";
const future = () => new Date(Date.now() + 300000).toISOString();

function fixture(override = {}) {
  let pending = null,
    active = override.active ?? null;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url),
      body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: parsed, path: parsed.pathname, body, init });
    if (override.fetch) {
      const result = await override.fetch(parsed.pathname, body, init);
      if (result) return result;
    }
    if (parsed.pathname.endsWith("/config"))
      return Response.json({
        ...binding,
        codeChallengeMethod: "S256",
        scopes: ["cloud:user"],
        app: { name: "Example Native" },
      });
    if (parsed.pathname === "/auth/oauth/exchange")
      return Response.json({ ok: true, token: SESSION, expiresIn: 900 });
    if (parsed.pathname === "/auth/mfa/totp/complete")
      return Response.json({ ok: true, token: SESSION });
    if (parsed.pathname.endsWith("/connect"))
      return Response.json({
        success: true,
        codeType: "mobile_app_auth_code",
        code: "private-grant",
        expiresAt: future(),
        accountCreated: true,
      });
    if (parsed.pathname.endsWith("/mobile/token"))
      return Response.json({
        success: true,
        credentialId: "22222222-2222-4222-8222-222222222222",
        secret: "private-credential-not-for-renderer",
        tokenType: "Bearer",
        acknowledgementRequired: true,
        acknowledgeBy: future(),
      });
    if (parsed.pathname.endsWith("/ack"))
      return Response.json({
        success: true,
        status: "acknowledged",
        credentialId: body.credentialId,
        expiresAt: future(),
      });
    throw new Error(`Unexpected route ${parsed.pathname}`);
  };
  const auth = createNativeCloudAuth({
    fetchImpl,
    auth: AUTH,
    binding,
    appName: "Example Native",
    googleRedirectUri: RETURN,
    ...override.options,
    pendingStore: {
      read: async () => pending,
      write: async (value) => {
        pending = value;
      },
      clear: async () => {
        pending = null;
      },
    },
    readActive: async () => active,
    clearActive: async () => {
      active = null;
    },
    activate: async (value, guard) => {
      guard();
      active = value;
    },
  });
  return {
    auth,
    calls,
    get active() {
      return active;
    },
    get pending() {
      return pending;
    },
  };
}

const startGoogle = (f) => f.auth.handle("start", { method: "google" });
const returnUrl = (state, code = STEWARD_CODE) =>
  `${RETURN}#${new URLSearchParams({ code, state })}`;
const stateOf = (begun) => new URL(begun.url).searchParams.get("state");
const exchanges = (f) =>
  f.calls.filter((call) => call.path === "/auth/oauth/exchange");

test("Google start returns Steward's PKCE authorize URL and keeps the verifier private", async () => {
  const f = fixture({ options: { authClientId: "example-app" } });
  const begun = await startGoogle(f);
  assert.equal(begun.status, "browser");
  assert.equal(typeof begun.sessionId, "string");
  assert.ok(Date.parse(begun.expiresAt) <= Date.now() + 5 * 60 * 1000);
  const url = new URL(begun.url);
  assert.equal(url.origin, AUTH);
  assert.equal(url.pathname, "/auth/oauth/google/authorize");
  assert.deepEqual([...url.searchParams.keys()].sort(), [
    "client_id",
    "code_challenge",
    "code_challenge_method",
    "mfa",
    "prompt",
    "redirect_uri",
    "response_type",
    "state",
    "tenant_id",
  ]);
  assert.equal(url.searchParams.get("redirect_uri"), RETURN);
  assert.equal(url.searchParams.get("tenant_id"), "elizacloud");
  assert.equal(url.searchParams.get("client_id"), "example-app");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("mfa"), "exchange");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.match(url.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  // Only the app-registration check runs before the browser opens.
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ["/api/v1/app-auth/mobile/config"],
  );
  assert.equal(JSON.stringify(begun).includes("verifier"), false);
});

test("Google return exchanges the fragment code with PKCE and enrolls through mobile_pkce", async () => {
  const f = fixture();
  const begun = await startGoogle(f);
  const challenge = new URL(begun.url).searchParams.get("code_challenge");
  const result = await f.auth.handle("google-return", {
    callbackUrl: returnUrl(stateOf(begun)),
  });
  assert.equal(result.status, "authenticated");
  assert.equal(result.connected, true);
  const [exchange] = exchanges(f);
  assert.equal(exchange.url.origin, AUTH);
  assert.deepEqual(Object.keys(exchange.body).sort(), [
    "code",
    "code_verifier",
    "redirect_uri",
    "tenant_id",
  ]);
  assert.equal(exchange.body.code, STEWARD_CODE);
  assert.equal(exchange.body.redirect_uri, RETURN);
  assert.equal(exchange.body.tenant_id, "elizacloud");
  assert.match(exchange.body.code_verifier, /^[A-Za-z0-9._~-]{43,128}$/);
  assert.equal(
    createHash("sha256")
      .update(exchange.body.code_verifier)
      .digest("base64url"),
    challenge,
  );
  const connect = f.calls.find((call) => call.path.endsWith("/connect"));
  assert.equal(connect.init.headers.Authorization, `Bearer ${SESSION}`);
  assert.equal(connect.body.flow, "mobile_pkce");
  assert.deepEqual(f.calls.map((call) => call.path).slice(1), [
    "/auth/oauth/exchange",
    "/api/v1/app-auth/connect",
    "/api/v1/app-auth/mobile/token",
    "/api/v1/app-auth/mobile/ack",
  ]);
  assert.equal(f.active, "private-credential-not-for-renderer");
  assert.equal(f.pending, null);
  assert.equal(JSON.stringify(result).includes(SESSION), false);
  // The session is still retained as memory-only billing authority.
  assert.equal((await f.auth.billingAuthority()).token, SESSION);
});

test("a matched Google return is single use", async () => {
  const f = fixture({
    fetch: (path) =>
      path === "/auth/oauth/exchange"
        ? new Response("{}", { status: 503 })
        : undefined,
  });
  const begun = await startGoogle(f);
  const callbackUrl = returnUrl(stateOf(begun));
  await assert.rejects(f.auth.handle("google-return", { callbackUrl }), {
    status: 502,
  });
  await assert.rejects(f.auth.handle("google-return", { callbackUrl }), {
    status: 410,
  });
  assert.equal(exchanges(f).length, 1);
  assert.equal(f.active, null);
});

test("a return for another attempt neither completes nor cancels the current one", async () => {
  const f = fixture();
  const begun = await startGoogle(f);
  await assert.rejects(
    f.auth.handle("google-return", { callbackUrl: returnUrl("x".repeat(43)) }),
    { status: 409, code: "google_state_mismatch" },
  );
  await assert.rejects(
    f.auth.handle("google-return", {
      callbackUrl: `${RETURN}?${new URLSearchParams({ error: "access_denied", state: "y".repeat(43) })}`,
    }),
    { status: 409, code: "google_state_mismatch" },
  );
  assert.equal(exchanges(f).length, 0);
  const result = await f.auth.handle("google-return", {
    callbackUrl: returnUrl(stateOf(begun)),
  });
  assert.equal(result.status, "authenticated");
});

test("malformed Google returns are refused before any exchange", async () => {
  const f = fixture();
  const begun = await startGoogle(f);
  const state = stateOf(begun);
  const fragment = (params) => `#${new URLSearchParams(params)}`;
  for (const callbackUrl of [
    `http://127.0.0.1:31338/auth/google/return${fragment({ code: STEWARD_CODE, state })}`,
    `http://localhost:31337/auth/google/return${fragment({ code: STEWARD_CODE, state })}`,
    `http://127.0.0.1:31337/other${fragment({ code: STEWARD_CODE, state })}`,
    `${RETURN}?extra=1${fragment({ code: STEWARD_CODE, state })}`,
    `${RETURN}${fragment({ code: STEWARD_CODE, state, token: "x" })}`,
    `${RETURN}#code=${STEWARD_CODE}&code=${STEWARD_CODE}&state=${state}`,
    `${RETURN}${fragment({ state })}`,
    `${RETURN}?code=${STEWARD_CODE}&state=${state}`,
    `${RETURN}?error=access_denied&state=${state}#code=${STEWARD_CODE}`,
    "not a url",
  ])
    await assert.rejects(
      f.auth.handle("google-return", { callbackUrl }),
      (error) => [400, 409].includes(error.status),
      callbackUrl,
    );
  await assert.rejects(
    f.auth.handle("google-return", {
      callbackUrl: returnUrl(state),
      sessionId: begun.sessionId,
    }),
    { status: 400 },
  );
  assert.equal(exchanges(f).length, 0);
  // A short code is refused only after the state matched, so the attempt is spent.
  await assert.rejects(
    f.auth.handle("google-return", { callbackUrl: returnUrl(state, "short") }),
    { status: 400 },
  );
  await assert.rejects(
    f.auth.handle("google-return", { callbackUrl: returnUrl(state) }),
    { status: 410 },
  );
});

test("Steward's failure link ends the attempt without an exchange", async () => {
  const f = fixture();
  const begun = await startGoogle(f);
  await assert.rejects(
    f.auth.handle("google-return", {
      callbackUrl: `${RETURN}?${new URLSearchParams({ error: "oauth_authentication_failed", state: stateOf(begun) })}`,
    }),
    { status: 401, code: "google_sign_in_failed" },
  );
  await assert.rejects(
    f.auth.handle("google-return", { callbackUrl: returnUrl(stateOf(begun)) }),
    { status: 410 },
  );
  assert.equal(exchanges(f).length, 0);
});

test("a second factor from the Google exchange finishes in-app through MFA", async () => {
  const f = fixture({
    fetch: (path) =>
      path === "/auth/oauth/exchange"
        ? Response.json({
            ok: true,
            mfaRequired: true,
            mfa: {
              type: "totp",
              challengeId: "challenge-1",
              expiresAt: future(),
            },
          })
        : undefined,
  });
  const begun = await startGoogle(f);
  const mfa = await f.auth.handle("google-return", {
    callbackUrl: returnUrl(stateOf(begun)),
  });
  assert.equal(mfa.status, "mfa");
  assert.equal(mfa.method, "totp");
  assert.equal(mfa.sessionId, begun.sessionId);
  assert.equal(JSON.stringify(mfa).includes("challenge-1"), false);
  const result = await f.auth.handle("mfa", {
    sessionId: begun.sessionId,
    code: "123456",
  });
  assert.equal(result.status, "authenticated");
  const complete = f.calls.find(
    (call) => call.path === "/auth/mfa/totp/complete",
  );
  assert.deepEqual(complete.body, {
    challengeId: "challenge-1",
    code: "123456",
  });
});

test("Google MFA retry uses the current private challenge and cancellation fences grant dispatch", {
  timeout: 15_000,
}, async (t) => {
  const receiptRead = Promise.withResolvers();
  const release = Promise.withResolvers();
  const replacementExpiry = new Date(Date.now() + 60_000).toISOString();
  const factors = [];
  const unexpected = [];
  let holdReceiptRead = false;
  const server = createServer(async (request, response) => {
    const route = new URL(request.url, "http://127.0.0.1").pathname;
    const send = (body, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (route === "/api/v1/app-auth/mobile/config") {
      return send({
        ...binding,
        codeChallengeMethod: "S256",
        scopes: ["cloud:user"],
      });
    }
    if (route === "/auth/oauth/exchange") {
      return send({
        ok: true,
        mfaRequired: true,
        mfa: {
          type: "totp",
          challengeId: "private-first-factor",
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        },
      });
    }
    if (
      route === "/auth/mfa/totp/complete" ||
      route === "/auth/mfa/sms/complete"
    ) {
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      factors.push({ route, body: JSON.parse(bytes) });
      if (factors.length === 1) return send({ ok: false }, 401);
      if (factors.length === 2)
        return send({
          ok: true,
          mfaRequired: true,
          mfa: {
            type: "sms",
            challengeId: "private-replacement-factor",
            expiresAt: replacementExpiry,
          },
        });
      holdReceiptRead = true;
      return send({ ok: true, token: SESSION });
    }
    unexpected.push(route);
    return send({ ok: false }, 404);
  });
  server.listen(0, "127.0.0.1");
  t.after(async () => {
    release.resolve();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const host = createNativeCloudAuth({
    api: origin,
    auth: origin,
    binding,
    appName: "Fixture",
    googleRedirectUri: RETURN,
    pendingStore: {
      read: async () => {
        if (holdReceiptRead) {
          holdReceiptRead = false;
          receiptRead.resolve();
          await release.promise;
        }
        return null;
      },
      write: async () => assert.fail("cancelled MFA cannot publish a receipt"),
      clear: async () => {},
    },
    activate: async () => assert.fail("cancelled MFA cannot activate"),
  });
  const begun = await startGoogle({ auth: host });
  const first = await host.handle("google-return", {
    callbackUrl: returnUrl(stateOf(begun)),
  });
  assert.equal(first.method, "totp");
  assert(!JSON.stringify(first).includes("private-first-factor"));
  const input = { sessionId: begun.sessionId, code: "123456" };
  await assert.rejects(host.handle("mfa", { ...input, sessionId: "wrong" }), {
    status: 410,
  });
  await assert.rejects(host.handle("mfa", { ...input, code: "123" }), {
    status: 400,
  });
  await assert.rejects(host.handle("mfa", input), { status: 401 });
  const second = await host.handle("mfa", input);
  assert.deepEqual(second, {
    status: "mfa",
    method: "sms",
    sessionId: begun.sessionId,
    expiresAt: replacementExpiry,
  });

  const rejected = assert.rejects(host.handle("mfa", input), {
    status: 409,
    code: SIGN_IN_CONFLICT.cancelled,
  });
  await receiptRead.promise;
  const cancelled = host.cancel();
  release.resolve();
  await rejected;
  assert.deepEqual(await cancelled, { status: "cancelled" });
  await assert.rejects(host.handle("mfa", input), { status: 410 });
  assert.deepEqual(factors, [
    {
      route: "/auth/mfa/totp/complete",
      body: { challengeId: "private-first-factor", code: input.code },
    },
    {
      route: "/auth/mfa/totp/complete",
      body: { challengeId: "private-first-factor", code: input.code },
    },
    {
      route: "/auth/mfa/sms/complete",
      body: { challengeId: "private-replacement-factor", code: input.code },
    },
  ]);
  assert.deepEqual(unexpected, []);
});

test("Google MFA refuses an expired challenge at its exact deadline", async (t) => {
  const expiresAt = future();
  const f = fixture({
    fetch: (route) =>
      route === "/auth/oauth/exchange"
        ? Response.json({
            ok: true,
            mfaRequired: true,
            mfa: { type: "totp", challengeId: "expired-factor", expiresAt },
          })
        : undefined,
  });
  const begun = await startGoogle(f);
  const mfa = await f.auth.handle("google-return", {
    callbackUrl: returnUrl(stateOf(begun)),
  });
  t.mock.method(Date, "now", () => Date.parse(mfa.expiresAt));
  await assert.rejects(
    f.auth.handle("mfa", { sessionId: mfa.sessionId, code: "123456" }),
    { status: 410 },
  );
  assert.equal(
    f.calls.some((call) => call.path.startsWith("/auth/mfa/")),
    false,
  );
});

test("an email code cannot be verified against a Google attempt", async () => {
  const f = fixture();
  const begun = await startGoogle(f);
  await assert.rejects(
    f.auth.handle("verify", { sessionId: begun.sessionId, code: "123456" }),
    { status: 409 },
  );
  assert.equal(
    f.calls.some((call) => call.path.includes("/verify")),
    false,
  );
});

test("Google attempts expire with Steward's authorize state and on cancel", async (t) => {
  const f = fixture();
  const begun = await startGoogle(f);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 5 * 60 * 1000);
  await assert.rejects(
    f.auth.handle("google-return", { callbackUrl: returnUrl(stateOf(begun)) }),
    { status: 410 },
  );
  t.mock.restoreAll();
  const again = await startGoogle(f);
  await f.auth.cancel();
  await assert.rejects(
    f.auth.handle("google-return", { callbackUrl: returnUrl(stateOf(again)) }),
    { status: 410 },
  );
  assert.equal(exchanges(f).length, 0);
});

test("Google sign-in is unavailable unless an app-owned return address is configured", async () => {
  const f = fixture({ options: { googleRedirectUri: undefined } });
  assert.equal((await f.auth.handle("config")).methods, undefined);
  await assert.rejects(startGoogle(f), {
    status: 503,
    code: "google_unavailable",
  });
  assert.deepEqual((await fixture().auth.handle("config")).methods, [
    "email",
    "phone",
    "google",
  ]);
  await assert.rejects(
    fixture().auth.handle("google-return", { callbackUrl: returnUrl("x") }),
    { status: 410 },
  );
});

test("an active credential blocks Google start", async () => {
  const f = fixture({ active: `eliza_${"0".repeat(64)}` });
  await assert.rejects(startGoogle(f), { status: 409 });
  assert.equal(f.calls.length, 0);
});

test("the Google return address must be https or loopback http and the client id Steward-shaped", () => {
  for (const googleRedirectUri of [
    "http://example.org/return",
    "http://10.0.2.2:31337/return",
    "https://example.org/return#x",
    "https://user:pass@example.org/return",
    "elizaos://auth/google",
    "nonsense",
  ])
    assert.throws(
      () => fixture({ options: { googleRedirectUri } }),
      TypeError,
      googleRedirectUri,
    );
  for (const googleRedirectUri of [
    "https://example.org/return",
    "http://localhost:9/return",
    "http://[::1]:9/return",
  ])
    assert.doesNotThrow(() => fixture({ options: { googleRedirectUri } }));
  for (const authClientId of [
    "org.example.native",
    "AB",
    "-bad",
    "x".repeat(65),
  ])
    assert.throws(() => fixture({ options: { authClientId } }), TypeError);
});

test("an https return address on an app-owned domain completes the same way", async () => {
  const https = "https://app.example.org/auth/google/return";
  const f = fixture({ options: { googleRedirectUri: https } });
  const begun = await startGoogle(f);
  assert.equal(new URL(begun.url).searchParams.get("redirect_uri"), https);
  const result = await f.auth.handle("google-return", {
    callbackUrl: `${https}#${new URLSearchParams({ code: STEWARD_CODE, state: stateOf(begun) })}`,
  });
  assert.equal(result.status, "authenticated");
  assert.equal(exchanges(f)[0].body.redirect_uri, https);
  await assert.rejects(
    fixture({ options: { googleRedirectUri: https } }).auth.handle(
      "google-return",
      {
        callbackUrl: `http://app.example.org/auth/google/return#code=x&state=y`,
      },
    ),
    { status: 410 },
  );
});
