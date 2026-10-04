import assert from "node:assert/strict";
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
    activate: async (value, guard) => {
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
  const secret = "eliza_mobile_" + "a".repeat(64);
  const failed = true;
  const f = fixture({
    active: secret,
    fetch: async (path, body, init, state) => {
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
    fetchImpl: async (url, init) => {
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
  const secret = "eliza_mobile_" + "b".repeat(64);
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
    active: "eliza_mobile_" + "c".repeat(64),
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
  const secret = "eliza_" + "e".repeat(64);
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
