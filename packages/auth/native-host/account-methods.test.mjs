import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createNativeAccountMethods } from "./account-methods.mjs";

const initial = Date.now();
const token = (mfaVerifiedAt = initial) =>
  `header.${Buffer.from(JSON.stringify({ mfaVerifiedAt, exp: Math.floor(initial / 1000) + 3600 })).toString("base64url")}.signature`;
function fixture({ replace } = {}) {
  let clock = initial,
    held = {
      token: token(),
      expiresAt: new Date(initial + 3600000).toISOString(),
    },
    override;
  const rows = [
    {
      id: "google-id",
      provider: "google",
      providerAccountId: "private-provider-subject",
    },
  ];
  let primaries = [
    { provider: "email", providerAccountId: "reader@example.test" },
  ];
  const calls = [];
  const host = createNativeAccountMethods({
    now: () => clock,
    getAuthority: async () => held,
    clearAuthority: () => {
      held = null;
    },
    replaceAuthority: async (next, previous) => {
      assert.equal(held.token, previous);
      if (replace) await replace();
      held = { ...held, token: next };
    },
    request: async (path, input, credential, method) => {
      calls.push({ path, input, credential, method });
      if (override) {
        const result = await override(path, input, method);
        if (result) return result;
      }
      if (/^\/auth\/mfa\/(sms|totp)\/status$/.test(path))
        return { ok: true, enabled: true };
      if (path === "/auth/mfa/sms/send")
        return { ok: true, expiresAt: new Date(clock + 300000).toISOString() };
      if (path.endsWith("/step-up")) return { ok: true, token: token(clock) };
      if (path === "/user/me/accounts")
        return {
          ok: true,
          data: {
            accounts: rows,
            primaryLoginMethods: primaries,
            privateCredential: "hidden",
          },
        };
      if (path === "/user/me/accounts/phone/sms/send")
        return {
          ok: true,
          data: {
            phone: "***0123",
            expiresAt: new Date(clock + 300000).toISOString(),
          },
        };
      if (path === "/user/me/accounts/phone/sms/verify")
        return {
          ok: true,
          data: {
            account: {
              id: "phone-id",
              provider: "phone",
              providerAccountId: `phone:${createHash("sha256").update(input.phone).digest("hex")}`,
            },
          },
        };
      if (method === "DELETE")
        return {
          ok: true,
          data: { deleted: true, issuedBefore: Math.floor(clock / 1000) },
        };
      throw Error("Unexpected synthetic route");
    },
  });
  return {
    host,
    rows,
    calls,
    setPrimaries: (value) => {
      primaries = value;
    },
    setAuthority: (value) => {
      held = value;
    },
    advance: (ms) => {
      clock += ms;
    },
    override: (fn) => {
      override = fn;
    },
  };
}
test("inventory exposes masked primary and stable local IDs without provider identifiers or authority", async () => {
  const f = fixture(),
    view = await f.host.handle("account-methods");
  assert.equal(view.methods[0].label, "r•••@example.test");
  assert.equal(view.methods[0].removable, false);
  assert.equal(view.methods[1].removable, true);
  assert.equal(view.securityCheckRequired, false);
  for (const secret of [
    "private-provider-subject",
    "hidden",
    token(),
    "reader@example.test",
  ])
    assert.ok(!JSON.stringify(view).includes(secret));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].credential, token());
  f.rows.push({
    id: "external",
    provider: "google",
    providerAccountId: "other",
    providerApp: { id: "other-app" },
  });
  const next = await f.host.handle("account-methods");
  assert.equal(next.methods[2].removable, false);
  await assert.rejects(
    f.host.handle("account-unlink", {
      reviewId: next.reviewId,
      methodId: "external",
    }),
    (e) => e.status === 409,
  );
});
test("absent, old and future MFA cannot authorize a factor mutation", async () => {
  for (const at of [undefined, initial - 270001, initial + 1]) {
    const f = fixture();
    f.setAuthority({
      token: at === undefined ? "opaque-unverified-session-value" : token(at),
      expiresAt: new Date(initial + 3600000).toISOString(),
    });
    assert.equal(
      (await f.host.handle("account-methods")).securityCheckRequired,
      true,
    );
    await assert.rejects(
      f.host.handle("account-phone-start", { phone: "+15555550123" }),
      (e) => e.code === "account_mfa_required",
    );
    assert.equal(f.calls.length, 1);
  }
  const f = fixture();
  f.setAuthority(null);
  await assert.rejects(
    f.host.handle("account-methods"),
    (e) => e.status === 428,
  );
  assert.equal(f.calls.length, 0);
});
test("unlink rereads ownership, consumes its review and clears private authority after confirmed revocation", async () => {
  const f = fixture(),
    view = await f.host.handle("account-methods");
  assert.deepEqual(
    await f.host.handle("account-unlink", {
      reviewId: view.reviewId,
      methodId: "google-id",
    }),
    { status: "removed", reauthenticationRequired: true },
  );
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].method, "DELETE");
  assert.equal(
    f.calls[2].path,
    "/user/me/accounts/google/private-provider-subject",
  );
  await assert.rejects(
    f.host.handle("account-methods"),
    (e) => e.status === 428,
  );
});
test("expired, changed, missing and last login methods never dispatch unlink", async () => {
  for (const change of [
    (f) => f.advance(60001),
    (f) => f.rows.splice(0),
    (f) => {
      f.rows[0].providerAccountId = "changed";
    },
    (f) => f.setPrimaries([]),
  ]) {
    const f = fixture(),
      view = await f.host.handle("account-methods");
    change(f);
    await assert.rejects(
      f.host.handle("account-unlink", {
        reviewId: view.reviewId,
        methodId: "google-id",
      }),
      (e) => e.status === 409,
    );
    assert.equal(f.calls.filter((x) => x.method === "DELETE").length, 0);
  }
});
test("lost unlink response consumes the review and permits only a fresh inventory", async () => {
  const f = fixture(),
    view = await f.host.handle("account-methods");
  f.override((_path, _input, method) => {
    if (method === "DELETE") throw Error("Synthetic lost response");
  });
  const input = { reviewId: view.reviewId, methodId: "google-id" };
  await assert.rejects(
    f.host.handle("account-unlink", input),
    (e) => e.code === "account_outcome_unknown",
  );
  await assert.rejects(
    f.host.handle("account-unlink", input),
    (e) => e.status === 409,
  );
  assert.equal(f.calls.filter((x) => x.method === "DELETE").length, 1);
  await f.host.handle("account-methods");
  assert.equal(f.calls.filter((x) => x.method === "DELETE").length, 1);
});
test("phone linking holds destination privately and allows corrected codes without automatic retry", async () => {
  const f = fixture(),
    started = await f.host.handle("account-phone-start", {
      phone: "+15555550123",
    });
  assert.equal(started.destination, "•••0123");
  assert.ok(!JSON.stringify(started).includes("+15555550123"));
  await assert.rejects(
    f.host.handle("account-phone-start", { phone: "+15555550123" }),
    (e) => e.status === 429,
  );
  await assert.rejects(
    f.host.handle("account-phone-verify", {
      sessionId: started.sessionId,
      code: "bad",
    }),
    (e) => e.status === 400,
  );
  f.override((path) => {
    if (path.endsWith("/verify"))
      throw Object.assign(Error("Rejected code"), { status: 401 });
  });
  await assert.rejects(
    f.host.handle("account-phone-verify", {
      sessionId: started.sessionId,
      code: "123456",
    }),
    (e) => e.status === 401,
  );
  f.override(null);
  assert.deepEqual(
    await f.host.handle("account-phone-verify", {
      sessionId: started.sessionId,
      code: "234567",
    }),
    { status: "linked" },
  );
  await assert.rejects(
    f.host.handle("account-phone-verify", {
      sessionId: started.sessionId,
      code: "234567",
    }),
    (e) => e.status === 410,
  );
  assert.equal(f.calls.filter((x) => x.path.endsWith("/verify")).length, 2);
});
test("ambiguous phone verification cannot replay and mismatched provider response never reports success", async () => {
  for (const mode of ["lost", "mismatch"]) {
    const f = fixture(),
      view = await f.host.handle("account-phone-start", {
        phone: "+15555550123",
      });
    f.override((path) => {
      if (path.endsWith("/verify")) {
        if (mode === "lost") throw Error("Lost response");
        return {
          ok: true,
          data: {
            account: {
              id: "other",
              provider: "phone",
              providerAccountId: "wrong-destination",
            },
          },
        };
      }
    });
    const input = { sessionId: view.sessionId, code: "123456" };
    await assert.rejects(
      f.host.handle("account-phone-verify", input),
      (e) => e.code === "account_outcome_unknown",
    );
    await assert.rejects(
      f.host.handle("account-phone-verify", input),
      (e) => e.status === 410,
    );
    assert.equal(f.calls.filter((x) => x.path.endsWith("/verify")).length, 1);
  }
});
test("account change during observation discards its result and old review cannot cross sessions", async () => {
  const f = fixture(),
    view = await f.host.handle("account-methods");
  f.override((path) => {
    if (path === "/user/me/accounts")
      f.setAuthority({
        token: token(initial - 1),
        expiresAt: new Date(initial + 3600000).toISOString(),
      });
  });
  await assert.rejects(
    f.host.handle("account-unlink", {
      reviewId: view.reviewId,
      methodId: "google-id",
    }),
    (e) => e.status === 428,
  );
  assert.equal(f.calls.filter((x) => x.method === "DELETE").length, 0);
});

test("security step-up keeps replacement authority private and invalidates old reviews", async () => {
  for (const method of ["totp", "sms"]) {
    const f = fixture();
    f.setAuthority({
      token: token(initial - 300000),
      expiresAt: new Date(initial + 3600000).toISOString(),
    });
    const review = await f.host.handle("account-methods");
    assert.deepEqual(await f.host.handle("account-security-status"), {
      methods: ["totp", "sms"],
      recentlyVerified: false,
    });
    const step = await f.host.handle("account-security-start", { method });
    assert.equal(step.method, method);
    assert.ok(!JSON.stringify(step).includes(token()));
    assert.deepEqual(
      await f.host.handle("account-security-verify", {
        sessionId: step.sessionId,
        code: "123456",
      }),
      { status: "verified" },
    );
    assert.equal(
      (await f.host.handle("account-security-status")).recentlyVerified,
      true,
    );
    await assert.rejects(
      f.host.handle("account-unlink", {
        reviewId: review.reviewId,
        methodId: "google-id",
      }),
      (e) => e.status === 409,
    );
    await assert.rejects(
      f.host.handle("account-security-verify", {
        sessionId: step.sessionId,
        code: "123456",
      }),
      (e) => e.status === 410,
    );
  }
});
test("security code correction is explicit and ambiguous or invalid replacement cannot replay", async () => {
  for (const mode of ["wrong", "lost", "old-token"]) {
    const f = fixture(),
      step = await f.host.handle("account-security-start", { method: "totp" });
    f.override((path) => {
      if (path.endsWith("/step-up")) {
        if (mode === "wrong")
          throw Object.assign(Error("Wrong code"), { status: 401 });
        if (mode === "lost") throw Error("Lost response");
        return { ok: true, token: token(initial - 300000) };
      }
    });
    const input = { sessionId: step.sessionId, code: "123456" };
    await assert.rejects(
      f.host.handle("account-security-verify", input),
      (e) =>
        mode === "wrong"
          ? e.status === 401
          : e.code === "account_security_unknown",
    );
    f.override(null);
    if (mode === "wrong")
      assert.deepEqual(await f.host.handle("account-security-verify", input), {
        status: "verified",
      });
    else
      await assert.rejects(
        f.host.handle("account-security-verify", input),
        (e) => e.status === 410,
      );
  }
});
test("failed SMS security resend invalidates prior challenge and expires at provider deadline", async () => {
  const f = fixture(),
    first = await f.host.handle("account-security-start", { method: "sms" });
  f.advance(60001);
  f.override((path) => {
    if (path === "/auth/mfa/sms/send") throw Error("Lost response");
  });
  await assert.rejects(
    f.host.handle("account-security-start", { method: "sms" }),
  );
  await assert.rejects(
    f.host.handle("account-security-verify", {
      sessionId: first.sessionId,
      code: "123456",
    }),
    (e) => e.status === 410,
  );
  f.override(null);
  f.advance(60001);
  const next = await f.host.handle("account-security-start", { method: "sms" });
  f.advance(300001);
  await assert.rejects(
    f.host.handle("account-security-verify", {
      sessionId: next.sessionId,
      code: "123456",
    }),
    (e) => e.status === 410,
  );
  assert.equal(f.calls.filter((x) => x.path.endsWith("/step-up")).length, 0);
});
test("cross-app reassignment after inventory prevents unlink", async () => {
  const f = fixture(),
    review = await f.host.handle("account-methods");
  f.rows[0].providerApp = { id: "other" };
  await assert.rejects(
    f.host.handle("account-unlink", {
      reviewId: review.reviewId,
      methodId: "google-id",
    }),
    (e) => e.status === 409,
  );
  assert.equal(f.calls.filter((x) => x.method === "DELETE").length, 0);
});

test("an accepted MFA code cannot replay after replacement authority is refused", async () => {
  const f = fixture({
    replace: async () => {
      throw Object.assign(new Error("Session refused"), { status: 401 });
    },
  });
  const step = await f.host.handle("account-security-start", {
    method: "totp",
  });
  const input = { sessionId: step.sessionId, code: "123456" };
  await assert.rejects(f.host.handle("account-security-verify", input), {
    status: 401,
  });
  await assert.rejects(f.host.handle("account-security-verify", input), {
    status: 410,
  });
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/step-up")).length,
    1,
  );
});

function firstSecurityFixture() {
  const f = fixture();
  f.override((path) => {
    if (path.endsWith("/status")) return { ok: true, enabled: false };
    if (path === "/auth/mfa/sms/enroll")
      return {
        ok: true,
        phone: "***0123",
        expiresAt: new Date(initial + 300000).toISOString(),
      };
    if (path === "/auth/mfa/sms/verify")
      return { ok: true, enabled: true, phone: "***0123" };
  });
  return f;
}
test("first SMS security enrollment clears revoked authority and never exposes its phone or code", async () => {
  const f = firstSecurityFixture();
  const step = await f.host.handle("account-security-enroll-start", {
    phone: "+15555550123",
  });
  assert.equal(step.destination, "***0123");
  assert.ok(!JSON.stringify(step).includes("+15555550123"));
  const result = await f.host.handle("account-security-enroll-verify", {
    sessionId: step.sessionId,
    code: "123456",
  });
  assert.deepEqual(result, {
    status: "enabled",
    reauthenticationRequired: true,
  });
  assert.equal(f.calls.at(-1).path, "/auth/mfa/sms/verify");
  assert.deepEqual(f.calls.at(-1).input, { code: "123456" });
  await assert.rejects(f.host.handle("account-security-status"), {
    status: 428,
  });
});
test("first security setup refuses existing methods and server enrollment denial", async () => {
  const existing = fixture();
  await assert.rejects(
    existing.host.handle("account-security-enroll-start", {
      phone: "+15555550123",
    }),
    { code: "account_security_already_enabled" },
  );
  assert.equal(
    existing.calls.filter((x) => x.path.endsWith("/enroll")).length,
    0,
  );
  const f = firstSecurityFixture();
  f.override((path) => {
    if (path.endsWith("/status")) return { ok: true, enabled: false };
    if (path.endsWith("/enroll"))
      throw Object.assign(Error("Recent identity verification required"), {
        status: 403,
      });
  });
  await assert.rejects(
    f.host.handle("account-security-enroll-start", { phone: "+15555550123" }),
    { status: 403 },
  );
});
test("ambiguous security enrollment verification clears authority rather than replaying a code", async () => {
  for (const mode of ["lost", "wrong-phone"]) {
    const f = firstSecurityFixture(),
      step = await f.host.handle("account-security-enroll-start", {
        phone: "+15555550123",
      });
    f.override((path) => {
      if (path.endsWith("/verify")) {
        if (mode === "lost") throw Error("Lost response");
        return { ok: true, enabled: true, phone: "***9999" };
      }
    });
    const input = { sessionId: step.sessionId, code: "123456" };
    await assert.rejects(
      f.host.handle("account-security-enroll-verify", input),
      { code: "account_security_enrollment_unknown" },
    );
    await assert.rejects(
      f.host.handle("account-security-enroll-verify", input),
      { status: 428 },
    );
    assert.equal(f.calls.filter((x) => x.path.endsWith("/verify")).length, 1);
  }
});
test("security enrollment supports explicit wrong-code correction but expires and fences account changes", async () => {
  const f = firstSecurityFixture(),
    step = await f.host.handle("account-security-enroll-start", {
      phone: "+15555550123",
    });
  f.override((path) => {
    if (path.endsWith("/verify"))
      throw Object.assign(Error("Wrong code"), { status: 401 });
  });
  await assert.rejects(
    f.host.handle("account-security-enroll-verify", {
      sessionId: step.sessionId,
      code: "123456",
    }),
    { status: 401 },
  );
  f.override((path) =>
    path.endsWith("/verify")
      ? { ok: true, enabled: true, phone: "***0123" }
      : null,
  );
  assert.equal(
    (
      await f.host.handle("account-security-enroll-verify", {
        sessionId: step.sessionId,
        code: "234567",
      })
    ).status,
    "enabled",
  );
  for (const change of [
    (x) => x.advance(300001),
    (x) =>
      x.setAuthority({
        token: token(initial - 1),
        expiresAt: new Date(initial + 3600000).toISOString(),
      }),
  ]) {
    const g = firstSecurityFixture(),
      next = await g.host.handle("account-security-enroll-start", {
        phone: "+15555550123",
      });
    change(g);
    await assert.rejects(
      g.host.handle("account-security-enroll-verify", {
        sessionId: next.sessionId,
        code: "123456",
      }),
      { status: 410 },
    );
    assert.equal(g.calls.filter((x) => x.path.endsWith("/verify")).length, 0);
  }
});
