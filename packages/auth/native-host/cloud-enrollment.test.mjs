import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNativeCloudAuth as createEnrollment } from "./cloud-enrollment.mjs";

const binding = Object.freeze({
  clientId: "org.example.native",
  environment: "test",
  redirectUri: "https://example.org/native/callback",
});
const createNativeCloudAuth = (options) =>
  createEnrollment({ ...options, binding, appName: "Example Native" });
const future = () => new Date(Date.now() + 300000).toISOString();
function fixture(override = {}) {
  let pending = null,
    active = override.active ?? null;
  const calls = [];
  const state = {
    get pending() {
      return pending;
    },
    get active() {
      return active;
    },
    calls,
  };
  const pendingStore = {
    read: async () => pending,
    write: async (value) => {
      pending = value;
    },
    clear: async () => {
      pending = null;
    },
    ...override.pendingStore,
  };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname,
      body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body, init });
    if (override.fetch) {
      const result = await override.fetch(path, body, init, state);
      if (result) return result;
    }
    if (path.endsWith("/config"))
      return Response.json({
        ...binding,
        codeChallengeMethod: "S256",
        scopes: ["cloud:user"],
        app: { name: "Example Native" },
      });
    if (path === "/auth/email/send")
      return Response.json({ ok: true, data: { expiresAt: future() } });
    if (
      path === "/auth/email/code/verify" ||
      path === "/auth/mfa/totp/complete"
    )
      return Response.json({
        ok: true,
        token: "private-session-token-not-for-renderer",
      });
    if (path.endsWith("/connect"))
      return Response.json({
        success: true,
        codeType: "mobile_app_auth_code",
        code: "private-grant",
        expiresAt: future(),
      });
    if (path.endsWith("/token"))
      return Response.json({
        success: true,
        credentialId: "22222222-2222-4222-8222-222222222222",
        secret: "private-credential-not-for-renderer",
        tokenType: "Bearer",
        acknowledgementRequired: true,
        acknowledgeBy: future(),
      });
    if (path.endsWith("/ack")) {
      assert.ok(pending, "credential must be durable before ack");
      assert.equal(active, null);
      return Response.json({
        success: true,
        status: "acknowledged",
        credentialId: body.credentialId,
        expiresAt: future(),
      });
    }
    if (path.endsWith("/current"))
      return Response.json({
        success: true,
        status: "revoked",
        credentialId: "22222222-2222-4222-8222-222222222222",
        revokedAt: new Date().toISOString(),
      });
    throw new Error("Unexpected route");
  };
  const auth = createNativeCloudAuth({
    fetchImpl,
    pendingStore,
    readActive: async () => active,
    clearActive: async () => {
      active = null;
    },
    activate: override.activate
      ? (value, guard) =>
          override.activate(value, guard, (next) => {
            active = next;
          })
      : async (value, guard) => {
          guard();
          active = value;
        },
    beforeStart: async () => {
      active = null;
    },
  });
  return { ...state, auth, pendingStore, state };
}
const start = (f) => f.auth.handle("start", { email: "synthetic@example.com" });
const verify = (f, start) =>
  f.auth.handle("verify", { sessionId: start.sessionId, code: "123456" });
test("native email sign-in persists before acknowledgement and returns no authority to renderer", async () => {
  const f = fixture(),
    begun = await start(f),
    result = await verify(f, begun);
  assert.deepEqual(result, { status: "authenticated", connected: true });
  assert.equal(f.state.pending, null);
  assert.equal(f.state.active, "private-credential-not-for-renderer");
  const connect = f.calls.find((x) => x.path.endsWith("/connect"));
  assert.equal(connect.body.clientId, binding.clientId);
  assert.equal(connect.body.codeChallengeMethod, "S256");
  assert.match(connect.body.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    connect.init.headers.Authorization,
    "Bearer private-session-token-not-for-renderer",
  );
  assert.ok(!JSON.stringify([begun, result]).includes("private-"));
});
test("unregistered client never sends a login email", async () => {
  const f = fixture({
    fetch: (path) =>
      path.endsWith("/config")
        ? Response.json({ error: "invalid_client" }, { status: 401 })
        : null,
  });
  await assert.rejects(start(f), { status: 401 });
  assert.equal(f.calls.length, 1);
});
test("wrong code stays retryable and remote error text is not exposed", async () => {
  let bad = true;
  const f = fixture({
    fetch: (path) =>
      path.endsWith("/code/verify") && bad
        ? Response.json({ error: "private-provider-secret" }, { status: 401 })
        : null,
  });
  const begun = await start(f);
  await assert.rejects(
    verify(f, begun),
    (error) => error.status === 401 && !error.message.includes("private"),
  );
  bad = false;
  assert.equal((await verify(f, begun)).connected, true);
});
test("lost acknowledgement keeps durable receipt and resumes without email or a new grant", async () => {
  let lost = true;
  const f = fixture({
    fetch: (path) =>
      path.endsWith("/ack") && lost ? Response.json({}, { status: 503 }) : null,
  });
  const begun = await start(f);
  await assert.rejects(verify(f, begun), { status: 502 });
  assert.ok(f.state.pending);
  assert.equal(f.state.active, null);
  lost = false;
  assert.equal((await f.auth.handle("resume")).connected, true);
  assert.equal(f.calls.filter((x) => x.path.endsWith("/connect")).length, 1);
});
test("pending credential cancellation revokes before forgetting it; failure stays recoverable", async () => {
  let revokeFails = true;
  const f = fixture({
    fetch: (path) =>
      path.endsWith("/ack")
        ? Response.json({}, { status: 503 })
        : path.endsWith("/current") && revokeFails
          ? Response.json({}, { status: 503 })
          : null,
  });
  const begun = await start(f);
  await assert.rejects(verify(f, begun));
  await assert.rejects(f.auth.cancel(), { status: 502 });
  assert.ok(f.state.pending);
  revokeFails = false;
  await f.auth.cancel();
  assert.equal(f.state.pending, null);
});
test("cancellation racing a durable write prevents ack and revokes the stored credential", async () => {
  let stored, release, entered;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    pendingStore: {
      read: async () => stored,
      write: async (value) => {
        entered();
        await gate;
        stored = value;
      },
      clear: async () => {
        stored = null;
      },
    },
  });
  const begun = await start(f);
  const verifying = verify(f, begun);
  await reached;
  const cancelling = f.auth.cancel();
  release();
  await assert.rejects(verifying, { status: 409 });
  await cancelling;
  assert.equal(
    f.calls.some((x) => x.path.endsWith("/ack")),
    false,
  );
  assert.equal(stored, null);
  assert.equal(f.state.active, null);
  assert.equal(f.calls.at(-1).init.method, "DELETE");
});
test("MFA must finish before a Cloud grant; challenge secrets remain private", async () => {
  const f = fixture({
    fetch: (path) =>
      path.endsWith("/code/verify")
        ? Response.json({
            ok: true,
            mfaRequired: true,
            mfa: {
              type: "totp",
              challengeId: "private-mfa-challenge",
              expiresAt: future(),
            },
          })
        : null,
  });
  const begun = await start(f),
    mfa = await verify(f, begun);
  assert.equal(mfa.status, "mfa");
  assert.equal(mfa.method, "totp");
  assert.ok(!JSON.stringify(mfa).includes("private"));
  assert.equal(
    f.calls.some((x) => x.path.endsWith("/connect")),
    false,
  );
  const result = await f.auth.handle("mfa", {
    sessionId: mfa.sessionId,
    code: "234567",
  });
  assert.equal(result.connected, true);
});
test("wrong attempt, malformed code, resend cooldown and unsupported MFA fail closed", async () => {
  const f = fixture(),
    begun = await start(f);
  await assert.rejects(
    f.auth.handle("verify", { sessionId: "wrong", code: "123456" }),
    { status: 410 },
  );
  await assert.rejects(
    f.auth.handle("verify", { sessionId: begun.sessionId, code: "123" }),
    { status: 400 },
  );
  await assert.rejects(start(f), { status: 429 });
  assert.equal(
    f.calls.filter((x) => x.path.endsWith("/code/verify")).length,
    0,
  );
});

test("active mobile disconnect journals before clearing, retries a lost response after restart", async () => {
  const secret = `eliza_mobile_${"a".repeat(64)}`;
  const failed = true;
  const f = fixture({
    active: secret,
    fetch: async (path, _body, _init, state) => {
      if (path.endsWith("/current")) {
        assert.equal(state.active, null);
        assert.equal(JSON.parse(state.pending).proof.secret, secret);
        if (failed) throw new Error("connection lost");
      }
    },
  });
  await assert.rejects(f.auth.cancel({ disconnect: true }));
  assert.equal(f.state.active, null);
  assert.equal(JSON.parse(f.state.pending).kind, "revocation");
  // A new module instance has no interactive session, but can recover the exact receipt.
  const restarted = createNativeCloudAuth({
    pendingStore: f.pendingStore,
    activate: async () => assert.fail("must never reactivate"),
    fetchImpl: async (_url, init) => {
      assert.equal(init.method, "DELETE");
      assert.equal(init.headers.Authorization, `Bearer ${secret}`);
      return Response.json({
        success: true,
        status: "revoked",
        credentialId: "22222222-2222-4222-8222-222222222222",
        revokedAt: new Date().toISOString(),
      });
    },
  });
  await assert.rejects(restarted.handle("resume"), { status: 409 });
  await restarted.cancel({ disconnect: true });
  assert.equal(f.state.pending, null);
});
test("failed disconnect journal preserves active key and never dispatches revocation", async () => {
  const secret = `eliza_mobile_${"b".repeat(64)}`;
  const f = fixture({
    active: secret,
    pendingStore: {
      write: async () => {
        throw new Error("storage unavailable");
      },
    },
  });
  await assert.rejects(f.auth.cancel({ disconnect: true }));
  assert.equal(f.state.active, secret);
  assert.equal(f.calls.length, 0);
});
test("disconnect rejects malformed receipt and never revokes developer credentials", async () => {
  const f = fixture({
    active: `eliza_mobile_${"c".repeat(64)}`,
    fetch: (path) =>
      path.endsWith("/current")
        ? Response.json({
            success: true,
            status: "revoked",
            credentialId: "wrong",
            revokedAt: new Date().toISOString(),
          })
        : null,
  });
  await assert.rejects(f.auth.cancel({ disconnect: true }), { status: 502 });
  assert.ok(f.state.pending);
  assert.equal(f.state.active, null);
  const developer = fixture({ active: "developer-key" });
  await developer.auth.cancel({ disconnect: true });
  assert.equal(developer.state.active, null);
  assert.equal(developer.calls.length, 0);
});
test("a new email login cannot silently discard an active app or CLI credential", async () => {
  for (const prefix of ["eliza_mobile_", "eliza_"]) {
    const f = fixture({ active: prefix + "d".repeat(64) });
    await assert.rejects(start(f), { status: 409 });
    assert.equal(f.calls.length, 0);
    assert.ok(f.state.active);
  }
});

test("phone sign-in binds code to validated phone and uses the existing private enrollment", async () => {
  const f = fixture({
    fetch: (path, body) => {
      if (path === "/auth/sms/send") {
        assert.equal(body.phone, "+12025550123");
        return Response.json({ ok: true, expiresAt: future() });
      }
      if (path === "/auth/sms/verify") {
        assert.equal(body.phone, "+12025550123");
        assert.equal(body.email, undefined);
        return Response.json({
          ok: true,
          token: "private-session-token-not-for-renderer",
        });
      }
    },
  });
  await assert.rejects(
    f.auth.handle("start", { method: "phone", phone: "2025550123" }),
    { status: 400 },
  );
  const step = await f.auth.handle("start", {
    method: "phone",
    phone: "+12025550123",
  });
  assert.equal((await verify(f, step)).connected, true);
  assert.equal(
    f.calls.some((c) => c.path === "/auth/email/code/verify"),
    false,
  );
});
test("Google CLI credential logout is journalled and revoked, including retries", async () => {
  const secret = `eliza_${"e".repeat(64)}`;
  const f = fixture({
    active: secret,
    fetch: (path) =>
      path.endsWith("/current")
        ? Response.json({
            success: true,
            status: "revoked",
            credentialId: "22222222-2222-4222-8222-222222222222",
            revokedAt: new Date().toISOString(),
          })
        : null,
  });
  await f.auth.cancel({ disconnect: true });
  assert.equal(f.state.active, null);
  assert.equal(f.state.pending, null);
  assert.equal(f.calls.filter((c) => c.path.endsWith("/current")).length, 1);
});

test("failed enrollment cancellation persists intent and cannot resume activation after restart", async () => {
  const f = fixture({
    fetch: (path) =>
      path.endsWith("/ack") || path.endsWith("/current")
        ? Response.json({}, { status: 503 })
        : null,
  });
  const begun = await start(f);
  await assert.rejects(verify(f, begun));
  await assert.rejects(f.auth.cancel(), { status: 502 });
  assert.equal(JSON.parse(f.state.pending).kind, "revocation");
  let acknowledgements = 0;
  const restarted = createNativeCloudAuth({
    pendingStore: f.pendingStore,
    activate: async () => assert.fail("Cancelled enrollment cannot activate"),
    fetchImpl: async (url, init) => {
      if (url.endsWith("/ack")) acknowledgements++;
      assert.equal(init.method, "DELETE");
      return Response.json({
        success: true,
        status: "revoked",
        credentialId: "22222222-2222-4222-8222-222222222222",
        revokedAt: new Date().toISOString(),
      });
    },
  });
  await assert.rejects(restarted.handle("resume"), { status: 409 });
  assert.equal(acknowledgements, 0);
  await restarted.cancel();
  assert.equal(f.state.pending, null);
});

test("cancellation journal failure does not clear the recovery proof or contact Cloud", async () => {
  let raw = null,
    rejectWrites = false;
  const f = fixture({
    pendingStore: {
      read: async () => raw,
      write: async (value) => {
        if (rejectWrites) throw new Error("storage unavailable");
        raw = value;
      },
      clear: async () => {
        raw = null;
      },
    },
    fetch: (path) =>
      path.endsWith("/ack") ? Response.json({}, { status: 503 }) : null,
  });
  const begun = await start(f);
  await assert.rejects(verify(f, begun));
  const original = raw;
  rejectWrites = true;
  await assert.rejects(f.auth.cancel(), /storage unavailable/);
  assert.equal(raw, original);
  assert.equal(
    f.calls.some((call) => call.path.endsWith("/current")),
    false,
  );
  rejectWrites = false;
  await f.auth.cancel();
  assert.equal(raw, null);
});

const ACCOUNT = {
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "33333333-3333-4333-8333-333333333333",
  email: "relative@example.com",
  phone_number: "+12025550123",
};
const sessionToken = (exp = Math.floor(Date.now() / 1000) + 900) =>
  [
    "eyJhbGciOiJub25lIn0",
    Buffer.from(
      JSON.stringify({
        exp,
        userId: ACCOUNT.id,
        tenantId: `personal-${ACCOUNT.id}`,
      }),
    ).toString("base64url"),
    "private-billing-signature",
  ].join(".");
/** Steward codes for the billing check resolve to `sessionAccount`; the stored key to ACCOUNT. */
function billingFixture({
  active = `eliza_mobile_${"f".repeat(64)}`,
  sessionAccount = ACCOUNT,
  token = sessionToken(),
  fetch,
} = {}) {
  const writes = [];
  const f = fixture({
    active,
    pendingStore: {
      write: async (value) => {
        writes.push(value);
      },
    },
    fetch: async (path, body, init, state) => {
      const custom = fetch && (await fetch(path, body, init, state));
      if (custom) return custom;
      if (path === "/api/v1/user") {
        const bearer = init.headers.Authorization;
        return Response.json({
          success: true,
          ...(bearer === `Bearer ${state.active}` ? ACCOUNT : sessionAccount),
        });
      }
      if (path === "/auth/email/code/verify" || path === "/auth/sms/verify")
        return Response.json({ ok: true, token });
      if (path === "/auth/sms/send")
        return Response.json({ ok: true, expiresAt: future() });
    },
  });
  return Object.assign(f, { writes });
}
const billingStart = (f, input = {}) => f.auth.handle("billing-start", input);
const billingVerify = (f, step) =>
  f.auth.handle("billing-verify", {
    sessionId: step.sessionId,
    code: "123456",
  });
const enrollmentPaths = ["/connect", "/token", "/ack", "/current"];

test("enrollment retains its session as memory-only billing authority bound to the new credential", async () => {
  const token = sessionToken();
  const g = fixture({
    fetch: (path) =>
      path === "/auth/email/code/verify"
        ? Response.json({ ok: true, token })
        : null,
  });
  assert.equal(await g.auth.billingAuthority(), null);
  const result = await verify(g, await start(g));
  assert.deepEqual(result, { status: "authenticated", connected: true });
  const authority = await g.auth.billingAuthority();
  assert.equal(authority.token, token);
  assert.ok(Date.parse(authority.expiresAt) > Date.now());
  assert.deepEqual(await g.auth.handle("billing-status"), {
    status: "authorized",
    expiresAt: authority.expiresAt,
  });
  // Never persisted, never in a renderer-facing result.
  assert.equal(g.state.pending, null);
  assert.ok(!JSON.stringify(result).includes(token));
  // Account change (the active credential is replaced) drops it.
  await g.auth.cancel({ disconnect: true });
  assert.equal(await g.auth.billingAuthority(), null);
});

test("billing re-verification defaults to the account's own email and never re-enrolls", async () => {
  const f = billingFixture();
  assert.deepEqual(await f.auth.handle("billing-status"), {
    status: "required",
  });
  const step = await billingStart(f);
  assert.equal(step.status, "code");
  assert.equal(step.method, "email");
  assert.equal(step.destination, "r•••@example.com");
  assert.ok(!JSON.stringify(step).includes("relative@"));
  const send = f.calls.find((c) => c.path === "/auth/email/send");
  assert.equal(send.body.email, ACCOUNT.email);
  const result = await billingVerify(f, step);
  assert.equal(result.status, "authorized");
  assert.ok(!JSON.stringify(result).includes("private"));
  const authority = await f.auth.billingAuthority();
  assert.equal(authority.expiresAt, result.expiresAt);
  assert.match(authority.token, /private-billing-signature$/);
  // The stored inference credential and pending store are untouched.
  assert.equal(f.state.active, `eliza_mobile_${"f".repeat(64)}`);
  assert.deepEqual(f.writes, []);
  assert.equal(
    f.calls.some((c) => enrollmentPaths.some((p) => c.path.endsWith(p))),
    false,
  );
});

test("billing re-verification can use the account phone and masks it", async () => {
  const f = billingFixture();
  const step = await billingStart(f, { method: "phone" });
  assert.equal(step.destination, "•••0123");
  const send = f.calls.find((c) => c.path === "/auth/sms/send");
  assert.equal(send.body.phone, ACCOUNT.phone_number);
  assert.equal((await billingVerify(f, step)).status, "authorized");
});

test("a code for a different user or organization is rejected and grants nothing", async () => {
  for (const sessionAccount of [
    { ...ACCOUNT, id: "44444444-4444-4444-8444-444444444444" },
    {
      ...ACCOUNT,
      organization_id: "55555555-5555-4555-8555-555555555555",
    },
  ]) {
    const f = billingFixture({ sessionAccount });
    const step = await billingStart(f, { email: "other@example.com" });
    await assert.rejects(billingVerify(f, step), {
      status: 403,
      code: "billing_account_mismatch",
    });
    assert.equal(await f.auth.billingAuthority(), null);
    // The attempt is spent; the same code cannot be retried.
    await assert.rejects(billingVerify(f, step), {
      code: "billing_session_expired",
    });
    assert.deepEqual(f.writes, []);
  }
});

test("billing re-verification requires a connected account and a valid destination", async () => {
  const none = billingFixture({ active: null });
  await assert.rejects(billingStart(none), {
    status: 409,
    code: "billing_not_enrolled",
  });
  assert.equal(none.calls.length, 0);
  const f = billingFixture({
    fetch: (path) =>
      path === "/api/v1/user"
        ? Response.json({ success: true, ...ACCOUNT, phone_number: null })
        : null,
  });
  await assert.rejects(billingStart(f, { method: "phone" }), {
    status: 400,
    code: "billing_destination_required",
  });
  assert.equal(
    f.calls.some((c) => c.path.startsWith("/auth/")),
    false,
  );
});

test("billing authority is cleared by cancel, explicit clear and expiry", async () => {
  const f = billingFixture();
  await billingVerify(f, await billingStart(f));
  assert.ok(await f.auth.billingAuthority());
  await f.auth.cancel();
  assert.equal(await f.auth.billingAuthority(), null);

  const expiring = billingFixture({
    token: sessionToken(Math.floor(Date.now() / 1000) + 20),
  });
  await assert.rejects(billingVerify(expiring, await billingStart(expiring)), {
    status: 410,
    code: "billing_session_expired",
  });
  assert.equal(await expiring.auth.billingAuthority(), null);

  const cleared = billingFixture();
  await billingVerify(cleared, await billingStart(cleared));
  cleared.auth.clearBillingAuthority();
  assert.equal(await cleared.auth.billingAuthority(), null);
});

test("billing authority follows the exact active credential, not just any credential", async () => {
  let active = `eliza_mobile_${"f".repeat(64)}`;
  // The host can replace the stored key outside this module (account change).
  const swapped = createNativeCloudAuth({
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/api/v1/user")
        return Response.json({ success: true, ...ACCOUNT });
      if (path === "/auth/email/send")
        return Response.json({ ok: true, expiresAt: future() });
      if (path === "/auth/email/code/verify")
        return Response.json({ ok: true, token: sessionToken() });
      throw new Error(`Unexpected route ${path} ${init.method}`);
    },
    pendingStore: {
      read: async () => null,
      write: async () => assert.fail("billing must not persist"),
      clear: async () => {},
    },
    activate: async () => assert.fail("billing must not activate"),
    readActive: async () => active,
  });
  const step = await swapped.handle("billing-start");
  await swapped.handle("billing-verify", {
    sessionId: step.sessionId,
    code: "123456",
  });
  assert.ok(await swapped.billingAuthority());
  active = `eliza_mobile_${"9".repeat(64)}`;
  assert.equal(await swapped.billingAuthority(), null);
  active = `eliza_mobile_${"f".repeat(64)}`;
  assert.equal(await swapped.billingAuthority(), null);
});

test("billing MFA completes before authority and unknown billing operations are refused", async () => {
  const f = billingFixture({
    fetch: (path) =>
      path === "/auth/email/code/verify"
        ? Response.json({
            ok: true,
            mfaRequired: true,
            mfa: {
              type: "totp",
              challengeId: "private-mfa-challenge",
              expiresAt: future(),
            },
          })
        : path === "/auth/mfa/totp/complete"
          ? Response.json({ ok: true, token: sessionToken() })
          : null,
  });
  const step = await billingStart(f);
  const mfa = await billingVerify(f, step);
  assert.equal(mfa.status, "mfa");
  assert.ok(!JSON.stringify(mfa).includes("private"));
  assert.equal(await f.auth.billingAuthority(), null);
  const result = await f.auth.handle("billing-mfa", {
    sessionId: mfa.sessionId,
    code: "234567",
  });
  assert.equal(result.status, "authorized");
  assert.ok(await f.auth.billingAuthority());
  await assert.rejects(f.auth.handle("billing-anything", {}), { status: 410 });
});

test("account inventory stays inside the private enrollment session and unlink clears it", async () => {
  const privateToken = [
    "header",
    Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 900,
        mfaVerifiedAt: Date.now(),
        userId: ACCOUNT.id,
        tenantId: `personal-${ACCOUNT.id}`,
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");
  const f = billingFixture({
    token: privateToken,
    fetch: (path, _body, init) => {
      if (path === "/user/me/accounts") {
        assert.equal(init.headers.Authorization, `Bearer ${privateToken}`);
        return Response.json({
          ok: true,
          data: {
            accounts: [
              {
                id: "linked-google",
                provider: "google",
                providerAccountId: "private-subject",
              },
            ],
            primaryLoginMethods: [
              { provider: "email", providerAccountId: "relative@example.com" },
            ],
          },
        });
      }
      if (path === "/user/me/accounts/google/private-subject") {
        assert.equal(init.method, "DELETE");
        assert.equal(init.headers.Authorization, `Bearer ${privateToken}`);
        return Response.json({
          ok: true,
          data: { deleted: true, issuedBefore: Math.floor(Date.now() / 1000) },
        });
      }
    },
  });
  await assert.rejects(f.auth.handle("account-methods"), { status: 428 });
  await billingVerify(f, await billingStart(f));
  const review = await f.auth.handle("account-methods");
  assert.equal(review.securityCheckRequired, false);
  assert.ok(!JSON.stringify(review).includes("private-subject"));
  assert.deepEqual(
    await f.auth.handle("account-unlink", {
      reviewId: review.reviewId,
      methodId: "linked-google",
    }),
    { status: "removed", reauthenticationRequired: true },
  );
  assert.equal(await f.auth.billingAuthority(), null);
  assert.equal(f.writes.length, 0);
});

test("cancel during linked-account observation discards the result and never dispatches unlink", async () => {
  let started, release;
  const seen = new Promise((resolve) => {
      started = resolve;
    }),
    held = new Promise((resolve) => {
      release = resolve;
    });
  const f = billingFixture({
    fetch: async (path) => {
      if (path === "/user/me/accounts") {
        started();
        await held;
        return Response.json({
          ok: true,
          data: {
            accounts: [],
            primaryLoginMethods: [
              { provider: "email", providerAccountId: "relative@example.com" },
            ],
          },
        });
      }
    },
  });
  await billingVerify(f, await billingStart(f));
  const read = f.auth.handle("account-methods");
  const rejected = assert.rejects(read, { status: 409 });
  await seen;
  await assert.rejects(f.auth.handle("account-methods"), { status: 409 });
  const cancelled = f.auth.cancel();
  release();
  await rejected;
  await cancelled;
  assert.equal(await f.auth.billingAuthority(), null);
  assert.equal(
    f.calls.filter((call) => call.init.method === "DELETE").length,
    0,
  );
});

for (const mismatch of [false, true])
  test(`account security replacement is private and account-bound: mismatch=${mismatch}`, async () => {
    const replacement = [
      "header",
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + 900,
          mfaVerifiedAt: Date.now(),
          userId: ACCOUNT.id,
          tenantId: `personal-${ACCOUNT.id}`,
        }),
      ).toString("base64url"),
      "replacement",
    ].join(".");
    const f = billingFixture({
      fetch: (path, _body, init) => {
        if (path === "/auth/mfa/totp/status")
          return Response.json({ ok: true, enabled: true });
        if (path === "/auth/mfa/totp/step-up")
          return Response.json({ ok: true, token: replacement });
        if (
          path === "/api/v1/user" &&
          init.headers.Authorization === `Bearer ${replacement}`
        )
          return Response.json({
            success: true,
            ...ACCOUNT,
            ...(mismatch ? { id: "different-account" } : {}),
          });
      },
    });
    await billingVerify(f, await billingStart(f));
    const step = await f.auth.handle("account-security-start", {
      method: "totp",
    });
    const operation = f.auth.handle("account-security-verify", {
      sessionId: step.sessionId,
      code: "123456",
    });
    if (mismatch) {
      await assert.rejects(operation, {
        code: "account_verification_mismatch",
      });
      assert.equal(await f.auth.billingAuthority(), null);
    } else {
      const result = await operation;
      assert.deepEqual(result, { status: "verified" });
      assert.equal((await f.auth.billingAuthority()).token, replacement);
      assert.ok(!JSON.stringify(result).includes(replacement));
    }
    assert.equal(f.writes.length, 0);
  });
test("cancellation during security token account verification cannot restore authority", async () => {
  let started, release;
  const seen = new Promise((resolve) => {
      started = resolve;
    }),
    held = new Promise((resolve) => {
      release = resolve;
    });
  const replacement = [
    "header",
    Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 900,
        mfaVerifiedAt: Date.now(),
        userId: ACCOUNT.id,
        tenantId: `personal-${ACCOUNT.id}`,
      }),
    ).toString("base64url"),
    "replacement",
  ].join(".");
  const f = billingFixture({
    fetch: async (path, _body, init) => {
      if (path === "/auth/mfa/totp/status")
        return Response.json({ ok: true, enabled: true });
      if (path === "/auth/mfa/totp/step-up")
        return Response.json({ ok: true, token: replacement });
      if (
        path === "/api/v1/user" &&
        init.headers.Authorization === `Bearer ${replacement}`
      ) {
        started();
        await held;
        return Response.json({ success: true, ...ACCOUNT });
      }
    },
  });
  await billingVerify(f, await billingStart(f));
  const step = await f.auth.handle("account-security-start", {
    method: "totp",
  });
  const operation = f.auth.handle("account-security-verify", {
    sessionId: step.sessionId,
    code: "123456",
  });
  const rejected = assert.rejects(operation, { status: 409 });
  await seen;
  const cancelled = f.auth.cancel();
  release();
  await rejected;
  await cancelled;
  assert.equal(await f.auth.billingAuthority(), null);
  assert.equal(f.writes.length, 0);
});

for (const method of ["email", "phone"]) {
  test(`account reauthentication requests personal authority for ${method}`, async () => {
    const f = billingFixture();
    await billingVerify(
      f,
      await billingStart(f, { purpose: "account", method }),
    );
    const requests = f.calls.filter(
      ({ path }) =>
        path === (method === "phone" ? "/auth/sms/send" : "/auth/email/send") ||
        path ===
          (method === "phone" ? "/auth/sms/verify" : "/auth/email/code/verify"),
    );
    assert.equal(requests.length, 2);
    for (const request of requests)
      assert.equal(Object.hasOwn(request.body, "tenantId"), false);
    assert.ok(await f.auth.billingAuthority());
    assert.equal(f.writes.length, 0);
  });
}

for (const claims of [
  { userId: ACCOUNT.id, tenantId: "elizacloud" },
  { userId: "someone-else", tenantId: "personal-someone-else" },
  { userId: ACCOUNT.id, tenantId: "personal-someone-else" },
]) {
  test(`account verification rejects mismatched personal claims ${JSON.stringify(claims)}`, async () => {
    const token = [
      "header",
      Buffer.from(
        JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 900 }),
      ).toString("base64url"),
      "signature",
    ].join(".");
    const f = billingFixture({ token });
    await assert.rejects(
      billingVerify(f, await billingStart(f, { purpose: "account" })),
      { code: "billing_account_mismatch" },
    );
    assert.equal(await f.auth.billingAuthority(), null);
  });
}

test("Cloud billing authority cannot be reused for personal account routes", async () => {
  const token = [
    "header",
    Buffer.from(
      JSON.stringify({
        userId: ACCOUNT.id,
        tenantId: "elizacloud",
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");
  const f = billingFixture({ token });
  await billingVerify(f, await billingStart(f));
  assert.ok(await f.auth.billingAuthority());
  await assert.rejects(f.auth.handle("account-methods"), { status: 428 });
  assert.equal(
    f.calls.some(({ path }) => path === "/user/me/accounts"),
    false,
  );
  const sent = f.calls.filter(
    ({ path }) =>
      path === "/auth/email/send" || path === "/auth/email/code/verify",
  );
  for (const request of sent) assert.equal(request.body.tenantId, "elizacloud");
});

test("account verification retains personal purpose through MFA", async () => {
  const f = billingFixture({
    fetch: (path) => {
      if (path === "/auth/email/code/verify")
        return Response.json({
          mfaRequired: true,
          mfa: {
            type: "totp",
            challengeId: "personal-challenge",
            expiresAt: future(),
          },
        });
      if (path === "/auth/mfa/totp/complete")
        return Response.json({ ok: true, token: sessionToken() });
    },
  });
  const step = await billingStart(f, { purpose: "account" });
  assert.equal((await billingVerify(f, step)).status, "mfa");
  assert.equal(await f.auth.billingAuthority(), null);
  assert.equal(
    (
      await f.auth.handle("billing-mfa", {
        sessionId: step.sessionId,
        code: "123456",
      })
    ).status,
    "authorized",
  );
  assert.ok(await f.auth.billingAuthority());
});

test("cancelling while the host activates the key leaves no revoked key active", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let reached;
  const activating = new Promise((resolve) => {
    reached = resolve;
  });
  const f = fixture({
    // A host that checks the guard, then persists the key asynchronously.
    activate: async (value, guard, setActive) => {
      guard();
      reached();
      await gate;
      setActive(value);
    },
  });
  const begun = await start(f);
  const verifying = verify(f, begun);
  await activating;
  const cancelling = f.auth.cancel();
  release();
  await assert.rejects(verifying);
  assert.deepEqual(await cancelling, { status: "cancelled" });
  // Cancel revoked the key in Cloud; it must not stay the active credential.
  assert.equal(f.state.active, null);
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/api-keys/current")).length,
    1,
  );
});

// Exercise the trusted host against real HTTP responses and a disk-backed active credential.
for (const phase of [
  "send",
  "verify",
  "mfa-challenge",
  "mfa-complete",
  "owner-read",
  "replace",
  "finish",
  "uncleared",
]) {
  test(`explicit billing clear fences in-flight ${phase}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "eliza-billing-clear-"));
    const activePath = join(directory, "active"),
      pendingPath = join(directory, "pending");
    const enrolled = phase === "finish";
    const activeKey = `eliza_${"a".repeat(64)}`,
      token = sessionToken();
    const replacement = [
      "header",
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + 900,
          mfaVerifiedAt: Date.now(),
          userId: ACCOUNT.id,
          tenantId: `personal-${ACCOUNT.id}`,
        }),
      ).toString("base64url"),
      "replacement",
    ].join(".");
    if (!enrolled) await writeFile(activePath, activeKey, { mode: 0o600 });
    let paused = false,
      entered,
      release,
      blockPath = null;
    const seen = new Promise((resolve) => {
      entered = resolve;
    });
    const future = () => new Date(Date.now() + 300000).toISOString();
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : {};
      if (request.url === blockPath && !paused) {
        paused = true;
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      let value;
      if (new URL(request.url, "http://127.0.0.1").pathname.endsWith("/config"))
        value = {
          clientId: "org.example.billing",
          environment: "test",
          redirectUri: "https://example.org/native/callback",
          codeChallengeMethod: "S256",
          scopes: ["cloud:user"],
        };
      else if (request.url === "/api/v1/user") value = ACCOUNT;
      else if (request.url === "/auth/email/send")
        value = { ok: true, expiresAt: future() };
      else if (request.url === "/auth/email/code/verify")
        value = ["mfa-challenge", "mfa-complete"].includes(phase)
          ? {
              mfaRequired: true,
              mfa: {
                type: "totp",
                challengeId: "disposable-factor",
                expiresAt: future(),
              },
            }
          : { ok: true, token };
      else if (request.url === "/auth/mfa/totp/complete")
        value = { ok: true, token };
      else if (request.url === "/auth/mfa/totp/status")
        value = { ok: true, enabled: true };
      else if (request.url === "/auth/mfa/totp/step-up")
        value = { ok: true, token: replacement };
      else if (request.url.endsWith("/connect"))
        value = {
          success: true,
          codeType: "mobile_app_auth_code",
          code: "disposable-grant",
          expiresAt: future(),
        };
      else if (request.url.endsWith("/token"))
        value = {
          success: true,
          credentialId: "22222222-2222-4222-8222-222222222222",
          secret: activeKey,
          tokenType: "Bearer",
          acknowledgementRequired: true,
          acknowledgeBy: future(),
        };
      else if (request.url.endsWith("/ack")) {
        assert.ok(await readFile(pendingPath, "utf8"));
        value = {
          success: true,
          status: "acknowledged",
          credentialId: body.credentialId,
          expiresAt: future(),
        };
      } else {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const read = async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    };
    const auth = createEnrollment({
      binding: {
        clientId: "org.example.billing",
        environment: "test",
        redirectUri: "https://example.org/native/callback",
      },
      appName: "Disposable Billing",
      api: base,
      auth: base,
      readActive: () => read(activePath),
      pendingStore: {
        read: () => read(pendingPath),
        write: (value) => writeFile(pendingPath, value, { mode: 0o600 }),
        clear: () => rm(pendingPath, { force: true }),
      },
      activate: async (secret, guard) => {
        guard();
        await writeFile(activePath, secret, { mode: 0o600 });
      },
    });
    try {
      let operation, input;
      if (enrolled) {
        const step = await auth.handle("start", { email: ACCOUNT.email });
        operation = "verify";
        input = { sessionId: step.sessionId, code: "123456" };
        blockPath = "/api/v1/app-auth/mobile/ack";
      } else if (phase === "send") {
        operation = "billing-start";
        input = {};
        blockPath = "/auth/email/send";
      } else {
        const step = await auth.handle("billing-start");
        operation = "billing-verify";
        input = { sessionId: step.sessionId, code: "123456" };
        if (phase === "mfa-complete") {
          const mfa = await auth.handle(operation, input);
          operation = "billing-mfa";
          input = { sessionId: mfa.sessionId, code: "123456" };
          blockPath = "/auth/mfa/totp/complete";
        } else if (phase === "replace") {
          await auth.handle(operation, input);
          const security = await auth.handle("account-security-start", {
            method: "totp",
          });
          operation = "account-security-verify";
          input = { sessionId: security.sessionId, code: "123456" };
          blockPath = "/api/v1/user";
        } else
          blockPath =
            phase === "owner-read" ? "/api/v1/user" : "/auth/email/code/verify";
      }
      const pending = auth.handle(operation, input);
      const outcome = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await seen;
      if (phase !== "uncleared") auth.clearBillingAuthority();
      release();
      const result = await outcome;
      if (enrolled) {
        assert.deepEqual(result.value, {
          status: "authenticated",
          connected: true,
        });
        assert.equal(await read(activePath), activeKey);
        assert.equal(await read(pendingPath), null);
      } else if (phase === "uncleared") {
        assert.equal(result.value.status, "authorized");
        assert.equal((await auth.billingAuthority()).token, token);
      } else {
        assert.ok(result.error instanceof Error);
        assert.ok(!(result.error instanceof TypeError));
        assert.equal(result.error.status, 409);
        assert.equal(await read(activePath), activeKey);
        assert.equal(await read(pendingPath), null);
      }
      if (phase !== "uncleared")
        assert.equal(await auth.billingAuthority(), null);
      if (phase === "send") {
        blockPath = null;
        const fresh = await auth.handle("billing-start");
        assert.equal(fresh.status, "code");
      }
    } finally {
      release?.();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
