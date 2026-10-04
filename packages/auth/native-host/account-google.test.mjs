import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createNativeAccountMethods } from "./account-methods.mjs";

function fixture() {
  let clock = Date.now(),
    authority = {
      token: `header.${Buffer.from(JSON.stringify({ mfaVerifiedAt: clock })).toString("base64url")}.signature`,
      expiresAt: new Date(clock + 3600000).toISOString(),
    },
    modify,
    complete;
  const calls = [],
    redirect = "https://product.example/link/callback";
  const host = createNativeAccountMethods({
    accountLinkRedirectUri: redirect,
    now: () => clock,
    getAuthority: async () => authority,
    clearAuthority: () => {},
    replaceAuthority: async () => {},
    request: async (path, input) => {
      calls.push({ path, input });
      if (path.endsWith("/challenge")) {
        const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        for (const [key, value] of Object.entries({
          client_id: "synthetic-client",
          redirect_uri: redirect,
          response_type: "code",
          scope: "openid email profile",
          state: "synthetic-state",
          code_challenge: input.codeChallenge,
          code_challenge_method: "S256",
        }))
          url.searchParams.set(key, value);
        if (modify) await modify(url);
        return {
          ok: true,
          data: {
            state: "synthetic-state",
            redirectUri: redirect,
            expiresIn: 240,
            authorizationUrl: url.href,
          },
        };
      }
      if (complete) return complete();
      return {
        ok: true,
        data: {
          account: {
            provider: "google",
            id: "opaque-method",
            providerAccountId: "private-subject",
          },
        },
      };
    },
  });
  return {
    host,
    calls,
    redirect,
    advance: (ms) => (clock += ms),
    changeAccount: () =>
      (authority = { ...authority, token: `${authority.token}changed` }),
    modify: (fn) => (modify = fn),
    complete: (fn) => (complete = fn),
  };
}
const start = (f) => f.host.handle("account-google-start");
const callback = (f, state = "synthetic-state") =>
  `${f.redirect}?state=${state}&code=synthetic-code`;
const finish = (f, attempt, callbackUrl = callback(f)) =>
  f.host.handle("account-google-complete", {
    sessionId: attempt.sessionId,
    callbackUrl,
  });

test("Google linking keeps verifier private, validates callback and consumes one code", async () => {
  const f = fixture(),
    attempt = await start(f);
  assert.equal(JSON.stringify(attempt).includes("codeVerifier"), false);
  assert.deepEqual(await finish(f, attempt), { status: "linked" });
  const body = f.calls[1].input;
  assert.equal(
    createHash("sha256").update(body.codeVerifier).digest("base64url"),
    f.calls[0].input.codeChallenge,
  );
  assert.equal(body.code, "synthetic-code");
  assert.equal(body.redirectUri, f.redirect);
  await assert.rejects(finish(f, attempt), { status: 410 });
  assert.equal(f.calls.length, 2);
});

test("Google linking refuses callback substitutions and duplicate values before exchange", async () => {
  for (const value of [
    "https://attacker.example/link/callback?state=synthetic-state&code=x",
    "https://product.example/wrong?state=synthetic-state&code=x",
    "https://product.example/link/callback?state=wrong&code=x",
    "https://product.example/link/callback?state=synthetic-state&code=x&code=y",
    "https://product.example/link/callback?state=synthetic-state&code=x#fragment",
  ]) {
    const f = fixture(),
      attempt = await start(f);
    await assert.rejects(finish(f, attempt, value), { status: 400 });
    assert.equal(f.calls.length, 1);
  }
});

test("Google linking rejects unverified provider destinations, scopes and bound fields", async () => {
  for (const mutate of [
    (url) => {
      url.hostname = "accounts.google.com.attacker.example";
    },
    (url) => url.searchParams.set("scope", "openid email gmail.readonly"),
    (url) => url.searchParams.set("code_challenge", "different"),
    (url) => url.searchParams.set("redirect_uri", "https://attacker.example"),
    (url) => url.searchParams.append("state", "duplicate"),
    (url) => url.searchParams.set("client_secret", "untrusted"),
  ]) {
    const f = fixture();
    f.modify(mutate);
    await assert.rejects(start(f), { status: 502 });
  }
});

test("Google linking fences account changes, expiry and explicit cancellation", async () => {
  for (const invalidate of [
    (f) => f.changeAccount(),
    (f) => f.advance(241000),
    (f) => f.host.handle("account-google-cancel"),
  ]) {
    const f = fixture(),
      attempt = await start(f);
    await invalidate(f);
    await assert.rejects(finish(f, attempt));
    assert.equal(f.calls.length, 1);
  }
});

test("provider cancellation consumes attempt without exchanging a code", async () => {
  const f = fixture(),
    attempt = await start(f);
  assert.deepEqual(
    await finish(
      f,
      attempt,
      `${f.redirect}?state=synthetic-state&error=access_denied`,
    ),
    { status: "cancelled" },
  );
  await assert.rejects(finish(f, attempt), { status: 410 });
  assert.equal(f.calls.length, 1);
});

test("ambiguous Google link exchange requires observation, never code replay", async () => {
  const f = fixture(),
    attempt = await start(f);
  f.complete(() => {
    throw Error("lost response");
  });
  await assert.rejects(finish(f, attempt), { code: "account_outcome_unknown" });
  await assert.rejects(finish(f, attempt), { status: 410 });
  assert.equal(f.calls.length, 2);
});

test("reset while challenge is in flight cannot revive a cancelled attempt", async () => {
  const f = fixture();
  let release, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  f.modify(async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = start(f);
  await ready;
  f.host.reset();
  release();
  await assert.rejects(pending, { status: 409 });
});

test("Google linking requires recent MFA before requesting authorization", async () => {
  const f = fixture();
  f.advance(271000);
  await assert.rejects(start(f), { code: "account_mfa_required" });
  assert.equal(f.calls.length, 0);
});

test("reset during exchange cannot report a late result as a completed link", async () => {
  const f = fixture(),
    attempt = await start(f);
  let release, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  f.complete(async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return {
      ok: true,
      data: {
        account: {
          provider: "google",
          id: "method",
          providerAccountId: "private-subject",
        },
      },
    };
  });
  const pending = finish(f, attempt);
  await ready;
  f.host.reset();
  release();
  await assert.rejects(pending, { code: "account_outcome_unknown" });
  await assert.rejects(finish(f, attempt), { status: 410 });
});

test("native callback return needs private state but no renderer session identifier", async () => {
  const f = fixture();
  assert.deepEqual(await f.host.handle("account-google-status"), {
    status: "idle",
  });
  await start(f);
  assert.equal(
    (await f.host.handle("account-google-status")).status,
    "pending",
  );
  await assert.rejects(
    f.host.handle("account-google-return", {
      callbackUrl: callback(f, "wrong"),
    }),
    { status: 400 },
  );
  assert.deepEqual(
    await f.host.handle("account-google-return", { callbackUrl: callback(f) }),
    { status: "linked" },
  );
  assert.deepEqual(await f.host.handle("account-google-status"), {
    status: "linked",
  });
  f.changeAccount();
  assert.deepEqual(await f.host.handle("account-google-status"), {
    status: "idle",
  });
});

test("unknown exchange status is observable without replay or private material", async () => {
  const f = fixture(),
    attempt = await start(f);
  f.complete(() => {
    throw Error("lost");
  });
  await assert.rejects(finish(f, attempt), { code: "account_outcome_unknown" });
  assert.deepEqual(await f.host.handle("account-google-status"), {
    status: "unknown",
  });
  assert.equal(f.calls.length, 2);
});
