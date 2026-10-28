// Native subscription entitlement client: signed short-lived entitlement verification,
// account binding, admission/outage/expiry states, background refresh scheduling, Cloud
// limit refusals with retry times and owner-facing copy. Plan names and allowance numbers
// are synthetic test data, never product prices or quotas.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  allowanceText,
  CLOCK_SKEW_MS,
  CREDIT_BALANCE_MAX_AGE_MS,
  checkEntitlement,
  clearEntitlementKeyCache,
  decodeEntitlement,
  describeSubscription,
  ENTITLEMENT_AUDIENCE,
  ENTITLEMENT_TYPE,
  EntitlementError,
  EntitlementRefresher,
  entitlementFromResponse,
  entitlementKeysFromResponse,
  FALLBACK_REFRESH_MS,
  fallbackPlanFromLimits,
  isEntitlementSignInFailure,
  MAX_ENTITLEMENT_LIFETIME_MS,
  nextRefreshDelay,
  normalizeSubscriptionCode,
  organizationCreditFromLimits,
  planAdmission,
  REFRESH_RETRY_MAX_MS,
  REFRESH_RETRY_MIN_MS,
  readServiceLimit,
  redeemFailureForStatus,
  redeemFailureMessage,
  redeemResultFromResponse,
  redeemSuccessMessage,
  SubscriptionRedeemError,
  serviceLimitMessage,
  serviceLimitNextChange,
  subscriptionSummary,
  subscriptionView,
  verifyEntitlement,
} from "./subscription-entitlement.ts";

const ISSUER = "https://api.eliza.app";
const USER = "22222222-2222-4222-8222-222222222222";
const ORG = "44444444-4444-4444-8444-444444444444";
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const b64 = (value) => Buffer.from(value).toString("base64url");
const json = (value) => b64(JSON.stringify(value));

async function keyPair(kid = "k1") {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = {
    ...(await webcrypto.subtle.exportKey("jwk", pair.publicKey)),
    kid,
  };
  const sign = async (claims, header = {}) => {
    const input = `${json({ alg: "ES256", typ: ENTITLEMENT_TYPE, kid, ...header })}.${json(claims)}`;
    const signature = new Uint8Array(
      await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        Buffer.from(input),
      ),
    );
    return `${input}.${b64(signature)}`;
  };
  return { jwk, sign };
}
const claims = (overrides = {}) => ({
  iss: ISSUER,
  aud: ENTITLEMENT_AUDIENCE,
  sub: USER,
  org: ORG,
  jti: "e-1",
  iat: NOW / 1000 - 60,
  exp: NOW / 1000 + 540,
  plan: { id: "p-synthetic", name: "Synthetic plan", status: "active" },
  allowance: {
    unit: "requests",
    period: "month",
    limit: 40,
    used: 3,
    resetsAt: NOW / 1000 + 86400,
  },
  services: ["inference", "maps"],
  ...overrides,
});
const expected = { userId: USER, organizationId: ORG, issuer: ISSUER };
const rejects = async (promise, code) =>
  assert.rejects(
    promise,
    (error) => error instanceof EntitlementError && error.code === code,
  );

test("a Cloud-signed entitlement verifies and binds plan, allowance, services and refresh time", async () => {
  const { jwk, sign } = await keyPair();
  const entitlement = await verifyEntitlement(
    await sign(claims()),
    [jwk],
    expected,
    NOW,
  );
  assert.equal(entitlement.plan.status, "active");
  assert.equal(entitlement.plan.name, "Synthetic plan");
  assert.deepEqual(entitlement.allowance, {
    unit: "requests",
    period: "month",
    limit: 40,
    used: 3,
    resetsAt: NOW + 86400000,
  });
  assert.deepEqual(entitlement.services, ["inference", "maps"]);
  assert.equal(entitlement.expiresAt, NOW + 540000);
  // Default refresh at three quarters of the lifetime, before expiry.
  assert.equal(entitlement.refreshAt, NOW - 60000 + 450000);
  // Cloud may ask for an earlier refresh inside the lifetime.
  const early = await verifyEntitlement(
    await sign(claims({ rfa: NOW / 1000 + 30 })),
    [jwk],
    expected,
    NOW,
  );
  assert.equal(early.refreshAt, NOW + 30000);
});

test("format v2 plan_allowance is read in micro-dollars; v1 tokens and unknown units stay valid", async () => {
  const { jwk, sign } = await keyPair();
  const period = {
    unit: "usd_micros",
    granted: 25_000_000,
    remaining: 12_345_678,
    periodStart: NOW / 1000 - 86400,
    resetsAt: NOW / 1000 + 86400,
  };
  const v2 = await verifyEntitlement(
    await sign(
      claims({ ver: 2, allowance: undefined, plan_allowance: period }),
    ),
    [jwk],
    expected,
    NOW,
  );
  assert.equal(v2.formatVersion, 2);
  assert.deepEqual(v2.allowance, {
    unit: "usd_micros",
    granted: 25_000_000,
    remaining: 12_345_678,
    periodStart: NOW - 86400000,
    resetsAt: NOW + 86400000,
  });
  const plain = await verifyEntitlement(
    await sign(claims({ ver: 2, allowance: undefined })),
    [jwk],
    expected,
    NOW,
  );
  assert.equal(plain.allowance, null);
  // v1 (no ver) keeps the v1 allowance and ignores a plan_allowance it does not define.
  const v1 = await verifyEntitlement(
    await sign(claims({ plan_allowance: period })),
    [jwk],
    expected,
    NOW,
  );
  assert.equal(v1.formatVersion, 1);
  assert.equal(v1.allowance.unit, "requests");
  // A later additive version is read the same way.
  assert.equal(
    (
      await verifyEntitlement(
        await sign(claims({ ver: 3, plan_allowance: period })),
        [jwk],
        expected,
        NOW,
      )
    ).allowance.unit,
    "usd_micros",
  );
  // An unknown unit or an inconsistent row hides the allowance and keeps the plan.
  for (const bad of [
    { ...period, unit: "eur_micros" },
    { ...period, remaining: 26_000_000 },
    { ...period, granted: 0, remaining: 0 },
    { ...period, resetsAt: period.periodStart },
    { ...period, granted: 1.5 },
    "x",
  ]) {
    const entitlement = await verifyEntitlement(
      await sign(claims({ ver: 2, allowance: undefined, plan_allowance: bad })),
      [jwk],
      expected,
      NOW,
    );
    assert.equal(entitlement.allowance, null);
    assert.equal(entitlement.plan.status, "active");
  }
  // An unreadable ver is v1: it never blocks the plan state.
  for (const ver of [0, -1, 1.5, "2"]) {
    const entitlement = await verifyEntitlement(
      await sign(claims({ ver, plan_allowance: period })),
      [jwk],
      expected,
      NOW,
    );
    assert.equal(entitlement.formatVersion, 1);
    assert.equal(entitlement.allowance.unit, "requests");
  }
});

test("signature, key, algorithm and encoding failures are never trusted", async () => {
  const { jwk, sign } = await keyPair();
  const other = await keyPair();
  const token = await sign(claims());
  const [header, payload, signature] = token.split(".");
  await rejects(
    verifyEntitlement(
      `${header}.${json(claims({ plan: { id: "x", name: "Upgraded", status: "active" } }))}.${signature}`,
      [jwk],
      expected,
      NOW,
    ),
    "signature",
  );
  await rejects(
    verifyEntitlement(token, [other.jwk], expected, NOW),
    "signature",
  );
  await rejects(
    verifyEntitlement(token, [{ ...jwk, kid: "k2" }], expected, NOW),
    "unknown-key",
  );
  await rejects(
    verifyEntitlement(token, [{ ...jwk, d: "private" }], expected, NOW),
    "signature",
  );
  await rejects(
    verifyEntitlement(
      `${json({ alg: "none", typ: ENTITLEMENT_TYPE, kid: "k1" })}.${payload}.${signature}`,
      [jwk],
      expected,
      NOW,
    ),
    "unsupported",
  );
  await rejects(
    verifyEntitlement(
      await sign(claims(), { alg: "ES256", typ: "JWT" }),
      [jwk],
      expected,
      NOW,
    ),
    "unsupported",
  );
  await rejects(
    verifyEntitlement(
      await sign(claims(), { crit: ["x"] }),
      [jwk],
      expected,
      NOW,
    ),
    "unsupported",
  );
  for (const bad of [
    "",
    "a.b",
    "a.b.c.d",
    "!!.e30.e30",
    `${header}.${payload}.`,
  ])
    assert.throws(() => decodeEntitlement(bad), EntitlementError);
});

test("account binding, issuer, audience and short lifetime are enforced", async () => {
  const { jwk, sign } = await keyPair();
  await rejects(
    verifyEntitlement(
      await sign(claims({ sub: "33333333-3333-4333-8333-333333333333" })),
      [jwk],
      expected,
      NOW,
    ),
    "account-mismatch",
  );
  // UUID letter case alone is the same account, on either side.
  assert.equal(
    (
      await verifyEntitlement(
        await sign(claims({ sub: USER.toUpperCase(), org: ORG.toUpperCase() })),
        [jwk],
        expected,
        NOW,
      )
    ).plan.status,
    "active",
  );
  await rejects(
    verifyEntitlement(
      await sign(claims({ org: undefined })),
      [jwk],
      expected,
      NOW,
    ),
    "account-mismatch",
  );
  await rejects(
    verifyEntitlement(
      await sign(claims()),
      [jwk],
      { ...expected, organizationId: null },
      NOW,
    ),
    "account-mismatch",
  );
  await rejects(
    verifyEntitlement(
      await sign(claims({ iss: "https://api-staging.eliza.app" })),
      [jwk],
      expected,
      NOW,
    ),
    "audience",
  );
  await rejects(
    verifyEntitlement(
      await sign(claims({ aud: "another-client" })),
      [jwk],
      expected,
      NOW,
    ),
    "audience",
  );
  await rejects(
    verifyEntitlement(
      await sign(claims({ exp: NOW / 1000 - 1, iat: NOW / 1000 - 120 })),
      [jwk],
      expected,
      NOW,
    ),
    "expired",
  );
  await rejects(
    verifyEntitlement(
      await sign(
        claims({
          exp: NOW / 1000 - 60 + MAX_ENTITLEMENT_LIFETIME_MS / 1000 + 1,
        }),
      ),
      [jwk],
      expected,
      NOW,
    ),
    "lifetime",
  );
  await rejects(
    verifyEntitlement(
      await sign(claims({ nbf: NOW / 1000 + CLOCK_SKEW_MS / 1000 + 240 })),
      [jwk],
      expected,
      NOW,
    ),
    "not-yet-valid",
  );
  await rejects(
    verifyEntitlement(
      await sign(claims({ plan: { id: "p", name: "P", status: "unlimited" } })),
      [jwk],
      expected,
      NOW,
    ),
    "malformed",
  );
  await rejects(
    verifyEntitlement(
      await sign(
        claims({ plan: { id: "p", name: "Bad\u0007name", status: "active" } }),
      ),
      [jwk],
      expected,
      NOW,
    ),
    "malformed",
  );
  // A configured audience accepts only its own signed service contract.
  const scoped = await sign(claims({ aud: "independent-service" }));
  assert.equal(
    (
      await verifyEntitlement(
        scoped,
        [jwk],
        { ...expected, audience: "independent-service" },
        NOW,
      )
    ).plan.status,
    "active",
  );
  await rejects(
    verifyEntitlement(scoped, [jwk], { ...expected, audience: "another" }, NOW),
    "audience",
  );
});

test("presentation uses only Cloud numbers, injects the product name and never mentions credits for plans", () => {
  const copy = {
    serviceName: "Nebula",
    productName: "Synthetic Phone",
    deviceNoun: "phone",
  };
  assert.equal(allowanceText(null), "Plan allowance details are in Cloud.");
  assert.match(
    allowanceText({
      unit: "requests",
      period: "month",
      limit: 40,
      used: 3,
      resetsAt: null,
    }),
    /^3 of 40 requests used this month\.$/,
  );
  const period = {
    unit: "usd_micros",
    granted: 25_000_000,
    remaining: 12_345_678,
    periodStart: NOW - 86400000,
    resetsAt: NOW + 86400000,
  };
  assert.match(
    allowanceText(period, NOW),
    /^49% of this billing period's plan allowance is left\. Resets .+\.$/,
  );
  assert.match(
    allowanceText({ ...period, remaining: 100 }, NOW),
    /^Less than 1% of this billing period's plan allowance is left\./,
  );
  assert.match(
    allowanceText({ ...period, remaining: 0 }, NOW),
    /^This billing period's plan allowance is used up\. Resets /,
  );
  assert.equal(
    allowanceText({ ...period, resetsAt: NOW - 1 }, NOW),
    "49% of this billing period's plan allowance is left.",
  );
  const views = [
    { kind: "checking" },
    {
      kind: "active",
      planName: "Synthetic plan",
      status: "active",
      allowance: null,
      expiresAt: NOW,
      refreshFailed: false,
    },
    {
      kind: "active",
      planName: "Synthetic plan",
      status: "past_due",
      allowance: null,
      expiresAt: NOW,
      refreshFailed: true,
    },
    {
      kind: "inactive",
      planName: null,
      status: "none",
      source: "billing-limits",
    },
    {
      kind: "inactive",
      planName: "Synthetic plan",
      status: "canceled",
      source: "entitlement",
    },
    { kind: "unavailable", reason: "outage" },
    { kind: "unavailable", reason: "not-published" },
    { kind: "expired", planName: "Synthetic plan" },
  ];
  for (const view of views)
    assert.doesNotMatch(
      JSON.stringify(describeSubscription(view, copy)),
      /credit|top.?up|\$|price|upgrade now/i,
      view.kind,
    );
  const none = describeSubscription(views[3], copy);
  assert.equal(none.headline, "No active plan");
  assert.equal(none.manageLabel, "Choose a plan");
  assert.equal(
    none.detail,
    "Synthetic Phone needs an active Nebula plan. Redeem a subscription code or choose a plan in Nebula. Nothing is purchased automatically, and your data on this phone is kept.",
  );
  assert.match(
    describeSubscription(views[3]).detail,
    /^This app needs an active Cloud plan\..*this device is kept\.$/,
  );
  assert.equal(
    describeSubscription(views[4]).headline,
    "Synthetic plan has ended",
  );
  assert.equal(describeSubscription(views[2]).manage, true);
  assert.match(describeSubscription(views[2]).detail, /Payment is past due/);
  assert.match(
    describeSubscription(views[5]).detail,
    /Local apps keep working/,
  );
  const credits = describeSubscription(
    { kind: "credits", source: "billing-limits" },
    copy,
  );
  assert.equal(credits.headline, "Nebula credits");
  assert.equal(credits.manageLabel, "Manage billing in Nebula");
});

test("the account summary carries plan, allowance, plan end and a current rate-limit retry", () => {
  const copy = { serviceName: "Nebula", productName: "Synthetic Phone" };
  const view = {
    kind: "active",
    planName: "Synthetic plan",
    status: "active",
    allowance: {
      unit: "usd_micros",
      granted: 100,
      remaining: 25,
      periodStart: NOW - 1000,
      resetsAt: NOW + 86400000,
    },
    expiresAt: NOW + 600000,
    refreshFailed: false,
    planEndsAt: NOW + 30 * 86400000,
  };
  const limit = { kind: "rate-limited", retryAfterMs: 30_000, resetsAt: null };
  const summary = subscriptionSummary(view, {
    lastLimit: limit,
    lastLimitAt: NOW - 10_000,
    now: NOW,
    copy,
  });
  assert.equal(summary.headline, "Synthetic plan");
  assert.equal(summary.admission, "admit");
  assert.match(
    summary.allowance,
    /^25% of this billing period's plan allowance is left\./,
  );
  assert.equal(summary.planEndsAt, NOW + 30 * 86400000);
  assert.equal(
    summary.limit,
    "The AI request rate limit was reached. Try again in about 20 seconds. Synthetic Phone did not retry your message.",
  );
  // A wait that has passed no longer applies; an allowance reset still in the future does.
  assert.equal(
    subscriptionSummary(view, {
      lastLimit: limit,
      lastLimitAt: NOW - 31_000,
      now: NOW,
    }).limit,
    null,
  );
  const exhausted = {
    kind: "allowance-exhausted",
    retryAfterMs: null,
    resetsAt: NOW + 86400000,
  };
  assert.match(
    subscriptionSummary(view, {
      lastLimit: exhausted,
      lastLimitAt: NOW - 3_600_000,
      now: NOW,
    }).limit,
    /allowance for this period is used up\. It resets /,
  );
  // A countdown that ran out is never shown as "about 1 second": the reset
  // still ahead says when to try again.
  const burst = {
    kind: "rate-limited",
    retryAfterMs: 30_000,
    resetsAt: NOW + 120_000,
  };
  assert.equal(
    subscriptionSummary(view, {
      lastLimit: burst,
      lastLimitAt: NOW - 60_000,
      now: NOW,
      copy,
    }).limit,
    "The AI request rate limit was reached. Try again in about 2 minutes. Synthetic Phone did not retry your message.",
  );
  // An unsigned snapshot plan reports its period end but no invented allowance.
  const snapshot = subscriptionSummary(
    {
      kind: "active",
      planName: "Plus",
      status: "active",
      allowance: null,
      expiresAt: NOW + 1000,
      refreshFailed: false,
      source: "billing-limits",
    },
    { now: NOW },
  );
  assert.equal(snapshot.allowance, null);
  assert.equal(snapshot.planEndsAt, NOW + 1000);
  assert.equal(subscriptionSummary(null, { now: NOW }).admission, "unknown");
});

function source({
  token = null,
  keys = [],
  fallback,
  fail,
  keyCalls = { n: 0 },
} = {}) {
  return {
    issuer: ISSUER,
    entitlement: async () => {
      if (fail) throw fail;
      return token;
    },
    entitlementKeys: async () => {
      keyCalls.n++;
      return keys;
    },
    ...(fallback === undefined
      ? {}
      : {
          fallbackPlan: async () => {
            if (fallback instanceof Error) throw fallback;
            return fallback;
          },
        }),
  };
}
const signal = () => new AbortController().signal;
const exp = { userId: USER, organizationId: ORG };

test("admission check: outage, unpublished route, billing snapshot fallback, invalid token and account change", async () => {
  clearEntitlementKeyCache();
  const { jwk, sign } = await keyPair();
  const now = () => NOW;
  assert.deepEqual(
    (
      await checkEntitlement(
        source({ fail: Error("offline") }),
        exp,
        signal(),
        now,
      )
    ).view,
    { kind: "unavailable", reason: "outage" },
  );
  assert.deepEqual(
    (
      await checkEntitlement(
        source({ fail: { code: "http", status: 503 } }),
        exp,
        signal(),
        now,
      )
    ).view,
    { kind: "unavailable", reason: "outage" },
  );
  assert.deepEqual(
    (await checkEntitlement(source(), exp, signal(), now)).view,
    { kind: "unavailable", reason: "not-published" },
  );
  assert.deepEqual(
    (
      await checkEntitlement(
        source({
          fallback: { status: "none", planName: null, periodEnd: null },
        }),
        exp,
        signal(),
        now,
      )
    ).view,
    {
      kind: "inactive",
      planName: null,
      status: "none",
      source: "billing-limits",
    },
  );
  assert.deepEqual(
    (
      await checkEntitlement(
        source({
          fallback: { status: "canceled", planName: "Plus", periodEnd: NOW },
        }),
        exp,
        signal(),
        now,
      )
    ).view,
    {
      kind: "inactive",
      planName: "Plus",
      status: "canceled",
      source: "billing-limits",
    },
  );
  assert.deepEqual(
    (
      await checkEntitlement(
        source({
          fallback: {
            status: "active",
            planName: "Plus",
            periodEnd: NOW + 1000,
          },
        }),
        exp,
        signal(),
        now,
      )
    ).view,
    {
      kind: "active",
      planName: "Plus",
      status: "active",
      allowance: null,
      expiresAt: NOW + 1000,
      refreshFailed: false,
      source: "billing-limits",
    },
  );
  assert.deepEqual(
    (await checkEntitlement(source({ fallback: null }), exp, signal(), now))
      .view,
    { kind: "unavailable", reason: "not-published" },
  );
  assert.deepEqual(
    (
      await checkEntitlement(
        source({ fallback: Object.assign(Error("503"), { status: 503 }) }),
        exp,
        signal(),
        now,
      )
    ).view,
    { kind: "unavailable", reason: "outage" },
  );
  await assert.rejects(
    checkEntitlement(
      source({ fail: Object.assign(Error("401"), { status: 401 }) }),
      exp,
      signal(),
      now,
    ),
  );
  await assert.rejects(
    checkEntitlement(
      source({
        fallback: Object.assign(Error("changed"), { code: "account-changed" }),
      }),
      exp,
      signal(),
      now,
    ),
  );
  await assert.rejects(
    checkEntitlement(
      source({
        token: await sign(
          claims({ sub: "33333333-3333-4333-8333-333333333333" }),
        ),
        keys: [jwk],
      }),
      exp,
      signal(),
      now,
    ),
    (error) => error.code === "account-mismatch",
  );
  const other = await keyPair();
  clearEntitlementKeyCache();
  assert.deepEqual(
    (
      await checkEntitlement(
        source({ token: await sign(claims()), keys: [other.jwk] }),
        exp,
        signal(),
        now,
      )
    ).view,
    { kind: "unavailable", reason: "invalid" },
  );
  // An expired signed entitlement is billing freshness, never an expired sign-in.
  clearEntitlementKeyCache();
  assert.deepEqual(
    (
      await checkEntitlement(
        source({
          token: await sign(
            claims({ iat: NOW / 1000 - 600, exp: NOW / 1000 - 1 }),
          ),
          keys: [jwk],
        }),
        exp,
        signal(),
        now,
      )
    ).view,
    { kind: "unavailable", reason: "invalid" },
  );
  assert.equal(
    isEntitlementSignInFailure(new EntitlementError("expired")),
    false,
  );
  assert.equal(isEntitlementSignInFailure({ code: "expired" }), true);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    checkEntitlement(source({ fail: Error("x") }), exp, aborted.signal, now),
  );
});

test("signing keys are cached by issuer and refetched only for an unknown key id", async () => {
  clearEntitlementKeyCache();
  const { jwk, sign } = await keyPair();
  const keyCalls = { n: 0 };
  const token = await sign(claims());
  for (let i = 0; i < 3; i++)
    assert.equal(
      (
        await checkEntitlement(
          source({ token, keys: [jwk], keyCalls }),
          exp,
          signal(),
          () => NOW,
        )
      ).view.kind,
      "active",
    );
  assert.equal(keyCalls.n, 1);
  const rotated = await keyPair("k2");
  await checkEntitlement(
    source({
      token: await rotated.sign(claims()),
      keys: [jwk, rotated.jwk],
      keyCalls,
    }),
    exp,
    signal(),
    () => NOW,
  );
  assert.equal(keyCalls.n, 2);
});

function fakeTimers(start = NOW) {
  let current = start;
  const t = {
    queue: [],
    now: () => current,
    setTimeout(handler, ms) {
      const item = { at: current + ms, handler };
      t.queue.push(item);
      return item;
    },
    clearTimeout(item) {
      t.queue = t.queue.filter((other) => other !== item);
    },
    async advance(ms) {
      const until = current + ms;
      for (;;) {
        t.queue.sort((a, b) => a.at - b.at);
        const next = t.queue[0];
        if (!next || next.at > until) break;
        t.queue.shift();
        current = next.at;
        next.handler();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      current = until;
    },
  };
  return t;
}
const entitlementAt = (iat, expiry, status = "active") => ({
  id: "e",
  keyId: "k1",
  issuer: ISSUER,
  userId: USER,
  organizationId: ORG,
  plan: { id: "p", name: "Synthetic plan", status },
  allowance: null,
  formatVersion: 1,
  services: [],
  issuedAt: iat,
  expiresAt: expiry,
  refreshAt: iat + Math.floor((expiry - iat) * 0.75),
});

test("refresh is scheduled from the entitlement, backs off on outage and reports expiry honestly", async () => {
  assert.equal(nextRefreshDelay(null, NOW, 0), null);
  assert.equal(
    nextRefreshDelay(entitlementAt(NOW, NOW + 400000), NOW, 0),
    300000,
  );
  assert.equal(nextRefreshDelay(null, NOW, 1), REFRESH_RETRY_MIN_MS);
  assert.equal(nextRefreshDelay(null, NOW, 2), REFRESH_RETRY_MIN_MS * 2);
  assert.equal(nextRefreshDelay(null, NOW, 50), REFRESH_RETRY_MAX_MS);
  for (const status of ["none", "canceled"])
    assert.equal(
      nextRefreshDelay(entitlementAt(NOW, NOW + 100000, status), NOW, 0),
      null,
    );

  const timers = fakeTimers();
  const views = [];
  let checks = 0,
    outcome = "outage";
  const refresher = new EntitlementRefresher({
    timers,
    entitlement: entitlementAt(NOW, NOW + 400000),
    onView: (view) => views.push(view),
    check: async () => {
      checks++;
      return outcome === "ok"
        ? {
            view: subscriptionView(
              entitlementAt(timers.now(), timers.now() + 400000),
            ),
            entitlement: entitlementAt(timers.now(), timers.now() + 400000),
          }
        : {
            view: { kind: "unavailable", reason: "outage" },
            entitlement: null,
          };
    },
  });
  await timers.advance(299999);
  assert.equal(checks, 0, "no refresh before refreshAt");
  await timers.advance(1);
  assert.equal(checks, 1);
  // Still valid: the plan stays shown, marked as not refreshed.
  assert.equal(views.at(-1).kind, "active");
  assert.equal(views.at(-1).refreshFailed, true);
  await timers.advance(REFRESH_RETRY_MIN_MS);
  assert.equal(checks, 2);
  // Failures continue until the entitlement lapses; then the owner sees "expired", not a stale plan.
  await timers.advance(400000);
  assert.ok(views.some((view) => view.kind === "expired"));
  const failedBefore = checks;
  await timers.advance(REFRESH_RETRY_MAX_MS * 3);
  assert.ok(checks > failedBefore);
  assert.deepEqual(views.at(-1), {
    kind: "expired",
    planName: "Synthetic plan",
  });
  const afterExpiry = checks;
  outcome = "ok";
  await timers.advance(REFRESH_RETRY_MAX_MS);
  assert.ok(checks > afterExpiry);
  assert.equal(views.at(-1).kind, "active");
  assert.equal(views.at(-1).refreshFailed, false);
  refresher.stop();
  const stoppedAt = checks;
  await timers.advance(3600000);
  assert.equal(checks, stoppedAt);
  assert.equal(timers.queue.length, 0);
});

test("revocation to no plan stops refreshing, and a rejected sign-in or account change stops the refresher", async () => {
  const timers = fakeTimers();
  const views = [];
  let checks = 0;
  new EntitlementRefresher({
    timers,
    entitlement: entitlementAt(NOW, NOW + 400000),
    onView: (view) => views.push(view),
    check: async () => {
      checks++;
      const entitlement = entitlementAt(NOW, NOW + 400000, "canceled");
      return { view: subscriptionView(entitlement), entitlement };
    },
  });
  await timers.advance(3600000);
  assert.equal(checks, 1);
  assert.equal(views.at(-1).kind, "inactive");

  const authTimers = fakeTimers();
  let auth = 0;
  new EntitlementRefresher({
    timers: authTimers,
    retry: true,
    onView: () => {},
    onAuthFailure: () => auth++,
    check: async () => {
      throw Object.assign(Error("401"), { status: 401 });
    },
  });
  await authTimers.advance(3600000);
  assert.equal(auth, 1);
  assert.equal(authTimers.queue.length, 0);

  const mismatchTimers = fakeTimers();
  const refused = [];
  const mismatchViews = [];
  new EntitlementRefresher({
    timers: mismatchTimers,
    entitlement: entitlementAt(NOW, NOW + 400000),
    onView: (view) => mismatchViews.push(view),
    onAuthFailure: (error) => refused.push(error),
    check: async () => {
      throw new EntitlementError("account-mismatch");
    },
  });
  await mismatchTimers.advance(3600000);
  assert.equal(refused.length, 1);
  assert.ok(isEntitlementSignInFailure(refused[0]));
  assert.deepEqual(mismatchViews, []);
  assert.equal(mismatchTimers.queue.length, 0);

  // A Cloud without the route is not polled.
  const legacyTimers = fakeTimers();
  let legacyChecks = 0;
  new EntitlementRefresher({
    timers: legacyTimers,
    retry: true,
    onView: () => {},
    check: async () => {
      legacyChecks++;
      return {
        view: { kind: "unavailable", reason: "not-published" },
        entitlement: null,
      };
    },
  });
  await legacyTimers.advance(3600000);
  assert.equal(legacyChecks, 1);
});

test("cached tokens past their refresh hint cannot cause a zero-delay refresh loop", async () => {
  const timers = fakeTimers();
  const entitlement = entitlementAt(NOW - 300000, NOW + 100000);
  let checks = 0;
  const refresher = new EntitlementRefresher({
    timers,
    entitlement,
    onView: () => {},
    check: async () => {
      checks++;
      return { view: subscriptionView(entitlement), entitlement };
    },
  });
  await timers.advance(90000);
  assert.equal(checks, 3);
  refresher.stop();
});

test("active billing snapshots and credit mode refresh in the background, recover outages and observe cancellation", async () => {
  const timers = fakeTimers(),
    views = [];
  let checks = 0;
  let result = {
    view: {
      kind: "active",
      source: "billing-limits",
      planName: "Plus",
      status: "active",
      allowance: null,
      expiresAt: NOW + 86400000,
      refreshFailed: false,
    },
    entitlement: null,
  };
  const refresher = new EntitlementRefresher({
    timers,
    fallbackActive: true,
    onView: (view) => views.push(view),
    check: async () => {
      checks++;
      return result;
    },
  });
  await timers.advance(FALLBACK_REFRESH_MS - 1);
  assert.equal(checks, 0);
  await timers.advance(1);
  assert.equal(checks, 1);
  result = {
    view: { kind: "unavailable", reason: "outage" },
    entitlement: null,
  };
  await timers.advance(FALLBACK_REFRESH_MS);
  assert.equal(checks, 2);
  assert.equal(views.at(-1).kind, "unavailable");
  result = {
    view: {
      kind: "inactive",
      source: "billing-limits",
      status: "canceled",
      planName: "Plus",
    },
    entitlement: null,
  };
  await timers.advance(REFRESH_RETRY_MIN_MS);
  assert.equal(checks, 3);
  assert.equal(views.at(-1).kind, "inactive");
  await timers.advance(FALLBACK_REFRESH_MS * 3);
  assert.equal(checks, 3);
  assert.equal(timers.queue.length, 0);
  refresher.stop();

  const creditTimers = fakeTimers();
  let creditChecks = 0,
    revoked = false,
    authFailures = 0;
  const credit = new EntitlementRefresher({
    timers: creditTimers,
    fallbackActive: true,
    onView: () => {},
    onAuthFailure: () => authFailures++,
    check: async () => {
      creditChecks++;
      if (revoked) throw Object.assign(Error("revoked"), { status: 401 });
      return {
        view: { kind: "credits", source: "billing-limits" },
        entitlement: null,
      };
    },
  });
  await creditTimers.advance(FALLBACK_REFRESH_MS * 2);
  assert.equal(creditChecks, 2);
  revoked = true;
  await creditTimers.advance(FALLBACK_REFRESH_MS);
  assert.equal(authFailures, 1);
  const stopped = creditChecks;
  await creditTimers.advance(FALLBACK_REFRESH_MS * 3);
  assert.equal(creditChecks, stopped);
  credit.stop();
});

test("organization credits supplement only a verified absence of a subscription", async () => {
  clearEntitlementKeyCache();
  const fallback = {
    status: "none",
    planName: null,
    periodEnd: null,
    billingMode: "organization-credits",
  };
  const creditView = {
    view: { kind: "credits", source: "billing-limits" },
    entitlement: null,
  };
  assert.deepEqual(
    await checkEntitlement(source({ fallback }), exp, signal(), () => NOW),
    creditView,
  );
  const { jwk, sign } = await keyPair("credit-mode");
  const none = await sign(
    claims({ plan: { id: "free", name: "Free", status: "none" } }),
  );
  assert.deepEqual(
    await checkEntitlement(
      source({ token: none, keys: [jwk], fallback }),
      exp,
      signal(),
      () => NOW,
    ),
    creditView,
  );
  assert.equal(planAdmission(creditView.view), "admit");
  // Canceled, invalid or mismatched signed authority never takes the credit path.
  let reads = 0;
  for (const [token, code] of [
    [
      await sign(
        claims({ plan: { id: "p", name: "Plan", status: "canceled" } }),
      ),
      null,
    ],
    ["invalid", null],
    [
      await sign(
        claims({
          plan: { id: "free", name: "Free", status: "none" },
          org: USER,
        }),
      ),
      "account-mismatch",
    ],
  ]) {
    const transport = source({ token, keys: [jwk] });
    transport.fallbackPlan = async () => {
      reads++;
      return fallback;
    };
    if (code)
      await assert.rejects(
        checkEntitlement(transport, exp, signal(), () => NOW),
        (error) => error.code === code,
      );
    else
      assert.notEqual(
        planAdmission(
          (await checkEntitlement(transport, exp, signal(), () => NOW)).view,
        ),
        "admit",
      );
  }
  assert.equal(reads, 0);
  // Unsigned plans, unknown snapshots and outages cannot promote a signed "none".
  for (const unconfirmed of [
    undefined,
    null,
    { status: "none", planName: null, periodEnd: null },
    { status: "active", planName: "Plus", periodEnd: NOW + 60000 },
    Object.assign(Error("offline"), { status: 503 }),
  ]) {
    const checked = await checkEntitlement(
      source({ token: none, keys: [jwk], fallback: unconfirmed }),
      exp,
      signal(),
      () => NOW,
    );
    assert.deepEqual(checked.view, {
      kind: "inactive",
      planName: null,
      status: "none",
      source: "entitlement",
    });
    assert.equal(planAdmission(checked.view), "needs-plan");
  }
});

test("Cloud limit refusals carry retry information and never imply a purchase or an automatic retry", () => {
  const copy = { serviceName: "Nebula", productName: "Synthetic Phone" };
  const rate = readServiceLimit(
    {
      code: "http",
      status: 429,
      data: { error: "rate_limited", retryAfterSeconds: 42 },
    },
    NOW,
  );
  assert.deepEqual(rate, {
    kind: "rate-limited",
    retryAfterMs: 42000,
    resetsAt: null,
  });
  assert.equal(
    serviceLimitMessage(rate, NOW, copy),
    "The AI request rate limit was reached. Try again in about 42 seconds. Synthetic Phone did not retry your message.",
  );
  assert.equal(
    serviceLimitMessage(null, NOW),
    "The AI request rate limit was reached. Wait a moment before sending again. This app did not retry your message.",
  );
  const allowance = readServiceLimit(
    {
      status: 429,
      data: {
        error: {
          code: "allowance_exhausted",
          resetsAt: new Date(NOW + 86400000).toISOString(),
        },
      },
    },
    NOW,
  );
  assert.equal(allowance.kind, "allowance-exhausted");
  assert.equal(allowance.resetsAt, NOW + 86400000);
  assert.match(
    serviceLimitMessage(allowance, NOW),
    /allowance for this period is used up\. It resets .+\. Nothing is purchased automatically\. Local apps keep working\.$/,
  );
  const subscription = readServiceLimit(
    { status: 402, data: { error: "subscription_required" } },
    NOW,
  );
  assert.equal(subscription.kind, "subscription-required");
  assert.match(
    serviceLimitMessage(subscription, NOW, copy),
    /active Nebula plan.*Nothing is purchased automatically/,
  );
  const bare = readServiceLimit({ status: 402, data: {} }, NOW);
  assert.equal(bare.kind, "billing-refused");
  assert.doesNotMatch(serviceLimitMessage(bare, NOW), /plan/i);
  // Agent terminal failures: provider wait retained, replays never invent one.
  const terminalFailure = {
    kind: "rate_limited",
    message: "Provider wait",
    transient: true,
    rateLimit: {
      kind: "rate_limited",
      retryAfterMs: 2400,
      planId: "pro",
      scope: "burst",
    },
  };
  for (const reply of [
    { failureKind: "rate_limited", terminalFailure },
    { error: { terminalFailure } },
  ])
    assert.deepEqual(readServiceLimit(reply, NOW), {
      kind: "rate-limited",
      retryAfterMs: 2400,
      resetsAt: null,
    });
  const { rateLimit, ...replay } = terminalFailure;
  assert.equal(
    readServiceLimit({ terminalFailure: replay }, NOW).retryAfterMs,
    null,
  );
  assert.equal(
    readServiceLimit(
      {
        terminalFailure: {
          ...terminalFailure,
          rateLimit: { ...rateLimit, retryAfterMs: 90000000 },
        },
      },
      NOW,
    ).retryAfterMs,
    null,
  );
  // A period allowance arrives as rate_limited scope:period: reset date, never the hour-capped wait.
  const resetAt = "2026-11-01T00:00:00.000Z";
  const period = {
    kind: "rate_limited",
    transient: false,
    rateLimit: {
      kind: "rate_limited",
      retryAfterMs: 3600000,
      scope: "period",
      resetAt,
      resetAfterSeconds: 1684800,
    },
  };
  assert.deepEqual(
    readServiceLimit(
      { failureKind: "rate_limited", terminalFailure: period },
      NOW,
    ),
    {
      kind: "allowance-exhausted",
      retryAfterMs: null,
      resetsAt: Date.parse(resetAt),
    },
  );
  assert.deepEqual(
    readServiceLimit(
      {
        failureKind: "insufficient_credits",
        retryAfterSeconds: 3600,
        terminalFailure: {
          kind: "insufficient_credits",
          rateLimit: {
            kind: "rate_limited",
            retryAfterMs: 3600000,
            scope: "period",
            resetAt,
          },
        },
      },
      NOW,
    ),
    {
      kind: "allowance-exhausted",
      retryAfterMs: null,
      resetsAt: Date.parse(resetAt),
    },
  );
  // A specific code wins over the generic kind; a long billing wait becomes the reset instant.
  assert.equal(
    readServiceLimit(
      {
        failureKind: "insufficient_credits",
        terminalFailure: {
          kind: "insufficient_credits",
          code: "subscription_required",
        },
      },
      NOW,
    ).kind,
    "subscription-required",
  );
  assert.deepEqual(
    readServiceLimit(
      {
        failureKind: "insufficient_credits",
        terminalFailure: {
          kind: "insufficient_credits",
          code: "allowance_exhausted",
        },
        retryAfterSeconds: 5 * 86400,
      },
      NOW,
    ),
    {
      kind: "allowance-exhausted",
      retryAfterMs: null,
      resetsAt: NOW + 5 * 86400000,
    },
  );
  // Retry-After header: delta seconds or IMF-fixdate only; a body wait wins.
  const anthropic = {
    code: "http",
    status: 429,
    data: { type: "error", error: { type: "rate_limit_error" } },
  };
  assert.equal(
    readServiceLimit({ ...anthropic, retryAfter: "30" }, NOW).retryAfterMs,
    30000,
  );
  assert.equal(
    readServiceLimit(
      { ...anthropic, retryAfter: new Date(NOW + 90000).toUTCString() },
      NOW,
    ).retryAfterMs,
    90000,
  );
  for (const junk of ["-5", "abc 2", "Sun Nov  6 08:49:37 1994", "30, 30"])
    assert.equal(
      readServiceLimit({ ...anthropic, retryAfter: junk }, NOW).retryAfterMs,
      null,
      junk,
    );
  assert.equal(
    readServiceLimit(
      {
        status: 429,
        data: { error: "rate_limited", retryAfterSeconds: 5 },
        retryAfter: "60",
      },
      NOW,
    ).retryAfterMs,
    5000,
  );
  assert.equal(readServiceLimit({ failureKind: "provider_error" }, NOW), null);
  assert.equal(readServiceLimit({ status: 500, data: {} }, NOW), null);
  for (const limit of [rate, allowance, subscription, bare])
    assert.doesNotMatch(
      serviceLimitMessage(limit, NOW),
      /credit|top.?up|upgrade|buy/i,
    );
});

test("billing snapshot fallback reads only known subscription states", () => {
  const limits = (subscription) => ({
    success: true,
    data: { v2: { subscription } },
  });
  const value = (state, extra = {}) =>
    limits({
      status: "available",
      value: {
        planKey: "plus_monthly",
        state,
        currentPeriodEnd: "2026-11-12T00:00:00.000Z",
        ...extra,
      },
    });
  assert.deepEqual(fallbackPlanFromLimits(value("active")), {
    status: "active",
    planName: "Plus",
    periodEnd: Date.parse("2026-11-12T00:00:00.000Z"),
  });
  for (const state of ["past_due", "grace", "unpaid"])
    assert.equal(
      fallbackPlanFromLimits(value(state)).status,
      "past_due",
      state,
    );
  for (const state of ["canceled", "incomplete_expired"])
    assert.equal(
      fallbackPlanFromLimits(value(state)).status,
      "canceled",
      state,
    );
  for (const state of ["pending", "incomplete", "paused", "unknown", 7])
    assert.equal(fallbackPlanFromLimits(value(state)), null, String(state));
  assert.deepEqual(
    fallbackPlanFromLimits(
      limits({
        status: "not_applicable",
        reason: "no_organization_subscription",
      }),
    ),
    {
      status: "none",
      planName: null,
      periodEnd: null,
      billingMode: "organization-credits",
    },
  );
  assert.deepEqual(
    fallbackPlanFromLimits(
      limits({ status: "not_applicable", reason: "unrecognized" }),
    ),
    { status: "none", planName: null, periodEnd: null },
  );
  assert.equal(fallbackPlanFromLimits({ success: true, data: {} }), null);
  assert.equal(
    fallbackPlanFromLimits(
      value("active", {
        planKey: "unlisted_plan",
        currentPeriodEnd: "not a date",
      }),
    ).planName,
    null,
  );
});

test("subscription codes normalize like Cloud; redemption responses and refusals never echo the code", () => {
  assert.equal(
    normalizeSubscriptionCode("  abcd-efgh-jkmn-pqrs "),
    "ABCDEFGHJKMNPQRS",
  );
  assert.equal(
    normalizeSubscriptionCode("oooo-iiii-llll-0000"),
    "0000111111110000",
  );
  for (const bad of [
    "",
    "short",
    "ABCD-EFGH-JKMN-PQR",
    "ABCD_EFGH_JKMN_PQRS",
    "x".repeat(129),
    null,
  ])
    assert.equal(normalizeSubscriptionCode(bad), null, String(bad));
  assert.equal(redeemFailureForStatus(401, {}), null);
  assert.equal(redeemFailureForStatus(400, {}).code, "invalid");
  assert.equal(
    redeemFailureForStatus(409, { code: "subscription_grant_already_redeemed" })
      .code,
    "already-redeemed",
  );
  assert.equal(redeemFailureForStatus(409, {}).code, "invalid");
  const limited = redeemFailureForStatus(429, {
    error: "rate_limited",
    retryAfterSeconds: 90,
  });
  assert.deepEqual(
    [limited.code, limited.retryAfterMs],
    ["rate-limited", 90000],
  );
  assert.equal(redeemFailureForStatus(429, {}, "12").retryAfterMs, 12000);
  assert.equal(redeemFailureForStatus(403, {}).code, "account");
  assert.equal(redeemFailureForStatus(503, {}).code, "unavailable");
  assert.equal(
    redeemFailureMessage(new SubscriptionRedeemError("invalid")),
    "This code could not be redeemed. Check the code and try again.",
  );
  assert.match(
    redeemFailureMessage(new SubscriptionRedeemError("rate-limited", 90_000)),
    /^Too many attempts\. Try again in about 2 minutes\.$/,
  );
  assert.match(
    redeemFailureMessage(new SubscriptionRedeemError("account"), {
      serviceName: "Nebula",
    }),
    /^Nebula could not apply a code/,
  );
  assert.doesNotMatch(
    redeemFailureMessage(new Error("ABCD-EFGH-JKMN-PQRS")),
    /ABCD/,
  );
  const grant = {
    endsAt: "2027-04-14T00:00:00.000Z",
    paidPlanTakesPrecedence: false,
  };
  assert.deepEqual(
    redeemResultFromResponse({
      success: true,
      replayed: false,
      grant,
      entitlement: {
        plan: { name: "Plus" },
        effectiveUntil: "2027-05-01T00:00:00.000Z",
      },
    }),
    {
      planEndsAt: Date.parse("2027-05-01T00:00:00.000Z"),
      replayed: false,
      grantEndsAt: Date.parse(grant.endsAt),
      paidPlanTakesPrecedence: false,
      planName: "Plus",
    },
  );
  assert.equal(
    redeemResultFromResponse({ success: true, replayed: true, grant })
      .planEndsAt,
    Date.parse(grant.endsAt),
  );
  assert.equal(
    redeemResultFromResponse({
      success: true,
      replayed: true,
      grant: { ...grant, paidPlanTakesPrecedence: true },
    }).planEndsAt,
    null,
  );
  assert.throws(
    () =>
      redeemResultFromResponse({
        success: true,
        replayed: true,
        grant: { ...grant, revoked: true },
      }),
    (error) => error.code === "invalid",
  );
  assert.throws(
    () => redeemResultFromResponse({ success: true, grant }),
    (error) => error.code === "unavailable",
  );
  assert.equal(
    redeemResultFromResponse({
      success: true,
      replayed: false,
      grant,
      entitlement: { plan: { name: "Bad\u0007" } },
    }).planName,
    null,
  );
  assert.match(
    redeemSuccessMessage({
      replayed: false,
      grantEndsAt: Date.UTC(2027, 3, 14),
      paidPlanTakesPrecedence: false,
      planName: "Plus",
    }),
    /^Code redeemed for Plus\. It runs until /,
  );
  assert.match(
    redeemSuccessMessage({
      replayed: true,
      grantEndsAt: null,
      paidPlanTakesPrecedence: true,
      planName: null,
    }),
    /current paid plan stays in effect/,
  );
});

test("entitlement and key responses are bounded and drop private or foreign keys", () => {
  assert.equal(entitlementFromResponse({ entitlement: "a.b.c" }), "a.b.c");
  for (const bad of [
    {},
    { entitlement: "" },
    { entitlement: "x".repeat(8193) },
    { entitlement: 7 },
    null,
  ])
    assert.equal(entitlementFromResponse(bad), null);
  const key = { kty: "EC", crv: "P-256", kid: "k", x: "x", y: "y" };
  assert.deepEqual(
    entitlementKeysFromResponse({
      keys: [
        key,
        { ...key, d: "private" },
        { ...key, crv: "P-384" },
        { ...key, kid: 1 },
        null,
      ],
    }),
    [key],
  );
  assert.equal(
    entitlementKeysFromResponse({ keys: Array(17).fill(key) }),
    null,
  );
  assert.equal(entitlementKeysFromResponse({}), null);
});

test("an outage retry answered by the billing snapshot switches to periodic checks; a stopped refresher never checks", async () => {
  const timers = fakeTimers();
  const views = [];
  let checks = 0;
  const refresher = new EntitlementRefresher({
    timers,
    retry: true,
    onView: (view) => views.push(view),
    check: async () => {
      checks++;
      return {
        view: {
          kind: "active",
          planName: "Plus",
          status: "active",
          allowance: null,
          expiresAt: 0,
          refreshFailed: false,
          source: "billing-limits",
        },
        entitlement: null,
      };
    },
  });
  await timers.advance(REFRESH_RETRY_MAX_MS * 4);
  assert.equal(checks, 4);
  assert.equal(views.at(-1).source, "billing-limits");
  refresher.refreshNow();
  await timers.advance(0);
  assert.equal(checks, 5, "refreshNow checks again on return");
  refresher.stop();
  refresher.refreshNow();
  assert.equal(checks, 5);
});

test("billing snapshot refresh adopts signed scheduling and discards a late result after detach", async () => {
  const timers = fakeTimers(),
    views = [];
  let checks = 0,
    release;
  const signed = entitlementAt(
    NOW + FALLBACK_REFRESH_MS,
    NOW + FALLBACK_REFRESH_MS + 400000,
  );
  const refresher = new EntitlementRefresher({
    timers,
    fallbackActive: true,
    onView: (view) => views.push(view),
    check: async () => {
      checks++;
      if (checks === 1)
        return { view: subscriptionView(signed), entitlement: signed };
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await timers.advance(FALLBACK_REFRESH_MS);
  assert.equal(refresher.current, signed);
  assert.equal(timers.queue[0].at, signed.refreshAt);
  await timers.advance(signed.refreshAt - timers.now());
  assert.equal(checks, 2);
  refresher.stop();
  release({
    view: {
      kind: "inactive",
      status: "canceled",
      source: "billing-limits",
      planName: "Plus",
    },
    entitlement: null,
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(views.length, 1);
  assert.equal(timers.queue.length, 0);
});

test("a signed no-subscription result that cannot confirm credit mode stops credit refresh as inactive", async () => {
  clearEntitlementKeyCache();
  const { jwk, sign } = await keyPair("credit-refresh-no-grace");
  const token = await sign(
    claims({ plan: { id: "free", name: "Free", status: "none" } }),
  );
  const refused = await checkEntitlement(
    source({
      token,
      keys: [jwk],
      fallback: Object.assign(Error("offline"), { status: 503 }),
    }),
    exp,
    signal(),
    () => NOW,
  );
  const timers = fakeTimers(),
    views = [];
  let checks = 0;
  const refresher = new EntitlementRefresher({
    timers,
    fallbackActive: true,
    onView: (view) => views.push(view),
    onAuthFailure: () => assert.fail("not an authentication failure"),
    check: async () => {
      checks++;
      return refused;
    },
  });
  await timers.advance(FALLBACK_REFRESH_MS);
  assert.deepEqual(views, [
    { kind: "inactive", planName: null, status: "none", source: "entitlement" },
  ]);
  assert.equal(timers.queue.length, 0);
  await timers.advance(FALLBACK_REFRESH_MS * 3);
  assert.equal(checks, 1);
  refresher.stop();
});

test("agent turn failures carry a structured period reset; burst and sustained stay countdowns; absent timing stays absent", () => {
  const copy = { serviceName: "Nebula" };
  const resetAt = new Date(NOW + 3 * 86400000).toISOString();
  const terminalFailure = {
    kind: "insufficient_credits",
    message: "Synthetic",
    transient: false,
  };
  for (const reply of [
    { failureKind: "insufficient_credits", terminalFailure, resetAt },
    {
      failureKind: "insufficient_credits",
      terminalFailure: { ...terminalFailure, resetAt },
    },
    {
      failureKind: "insufficient_credits",
      terminalFailure,
      retryAfterSeconds: 3 * 86400,
    },
  ]) {
    const limit = readServiceLimit(reply, NOW);
    assert.deepEqual(limit, {
      kind: "billing-refused",
      retryAfterMs: null,
      resetsAt: NOW + 3 * 86400000,
    });
    assert.match(
      serviceLimitMessage(limit, NOW, copy),
      /^Nebula declined this AI request for your account's billing\. Nebula reports your plan allowance resets .+\. Check your account in Settings\./,
    );
  }
  assert.equal(
    readServiceLimit(
      {
        failureKind: "insufficient_credits",
        terminalFailure,
        resetAt,
        retryAfterSeconds: 10 * 86400,
      },
      NOW,
    ).resetsAt,
    NOW + 3 * 86400000,
  );
  assert.doesNotMatch(
    serviceLimitMessage(
      readServiceLimit(
        {
          failureKind: "insufficient_credits",
          terminalFailure,
          resetAt: new Date(NOW - 1000).toISOString(),
        },
        NOW,
      ),
      NOW,
    ),
    /resets/,
  );
  assert.deepEqual(
    readServiceLimit(
      {
        failureKind: "insufficient_credits",
        terminalFailure: { ...terminalFailure, code: "allowance_exhausted" },
        retryAfterSeconds: 120,
      },
      NOW,
    ),
    { kind: "allowance-exhausted", retryAfterMs: 120000, resetsAt: null },
  );
  assert.deepEqual(
    readServiceLimit(
      {
        failureKind: "rate_limited",
        terminalFailure: { kind: "rate_limited" },
        retryAfterSeconds: 5 * 86400,
      },
      NOW,
    ),
    { kind: "rate-limited", retryAfterMs: null, resetsAt: null },
  );
  assert.equal(
    readServiceLimit(
      {
        failureKind: "insufficient_credits",
        terminalFailure,
        retryAfterSeconds: 1000 * 86400,
      },
      NOW,
    ).resetsAt,
    null,
  );
  const absent = readServiceLimit(
    { failureKind: "insufficient_credits", terminalFailure },
    NOW,
  );
  assert.deepEqual(absent, {
    kind: "billing-refused",
    retryAfterMs: null,
    resetsAt: null,
  });
  assert.doesNotMatch(serviceLimitMessage(absent, NOW), /resets|plan/i);
  const period = {
    kind: "rate_limited",
    message: "m",
    transient: false,
    rateLimit: {
      kind: "rate_limited",
      retryAfterMs: 3600000,
      planId: "pro",
      scope: "period",
      resetAt: "2026-11-01T00:00:00.000Z",
      resetAfterSeconds: 1684800,
    },
  };
  const { resetAt: _omit, ...relative } = period.rateLimit;
  assert.deepEqual(
    readServiceLimit(
      {
        failureKind: "rate_limited",
        terminalFailure: { ...period, rateLimit: relative },
      },
      NOW,
    ),
    {
      kind: "allowance-exhausted",
      retryAfterMs: null,
      resetsAt: NOW + 1684800000,
    },
  );
  const { resetAt: _a, resetAfterSeconds: _b, ...bare } = period.rateLimit;
  const unknown = readServiceLimit(
    {
      failureKind: "rate_limited",
      terminalFailure: { ...period, rateLimit: bare },
    },
    NOW,
  );
  assert.deepEqual(unknown, {
    kind: "allowance-exhausted",
    retryAfterMs: null,
    resetsAt: null,
  });
  assert.equal(
    serviceLimitMessage(unknown, NOW),
    "Your plan's AI allowance for this period is used up. Nothing is purchased automatically. Local apps keep working.",
  );
  for (const scope of ["burst", "sustained"]) {
    const burst = {
      kind: "rate_limited",
      message: "Provider wait",
      transient: true,
      rateLimit: {
        kind: "rate_limited",
        retryAfterMs: 2400,
        planId: "pro",
        scope,
        resetAfterSeconds: 30,
      },
    };
    const limit = readServiceLimit(
      { failureKind: "rate_limited", terminalFailure: burst },
      NOW,
    );
    assert.equal(limit.kind, "rate-limited", scope);
    assert.match(
      serviceLimitMessage(limit, NOW),
      /rate limit was reached\. Try again in about 3 seconds\./,
      "retryAfterMs still wins the countdown",
    );
  }
});

test("organization credit balance reads only a fresh exact organizations observation", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const payload = (balance, overrides = {}) => ({
    success: true,
    data: {
      schemaVersion: 2,
      v2: {
        balance: {
          status: "available",
          source: "organizations",
          observedAt: "2026-10-28T11:59:00Z",
          value: {
            balance: { value: balance, unit: "usd", currency: "USD" },
            revision: "42",
          },
          ...overrides,
        },
      },
    },
  });
  assert.deepEqual(organizationCreditFromLimits(payload("12.5"), now), {
    state: "funded",
    usd: "12.5",
    observedAt: Date.parse("2026-10-28T11:59:00Z"),
  });
  assert.equal(
    organizationCreditFromLimits(payload("0.000"), now).state,
    "zero",
  );
  for (const bad of ["-1", "1e3", "01", "1.1234567", "", "NaN"])
    assert.equal(
      organizationCreditFromLimits(payload(bad), now).state,
      "unavailable",
      bad,
    );
  const stale = new Date(now - CREDIT_BALANCE_MAX_AGE_MS - 1).toISOString();
  assert.equal(
    organizationCreditFromLimits(payload("5", { observedAt: stale }), now)
      .state,
    "unavailable",
  );
  const future = new Date(now + CLOCK_SKEW_MS + 1).toISOString();
  assert.equal(
    organizationCreditFromLimits(payload("5", { observedAt: future }), now)
      .state,
    "unavailable",
  );
  assert.equal(
    organizationCreditFromLimits(payload("5", { source: "stripe" }), now).state,
    "unavailable",
  );
  assert.equal(
    organizationCreditFromLimits(
      payload("5", {
        status: "unavailable",
        error: { code: "x", retryable: true },
      }),
      now,
    ).usd,
    null,
  );
  const unrevisioned = payload("5");
  unrevisioned.data.v2.balance.value.revision = 42;
  assert.equal(
    organizationCreditFromLimits(unrevisioned, now).state,
    "unavailable",
  );
  const v1 = payload("5");
  v1.data.schemaVersion = 1;
  assert.equal(organizationCreditFromLimits(v1, now).state, "unavailable");
  assert.equal(
    organizationCreditFromLimits({ ...payload("5"), success: false }, now)
      .state,
    "unavailable",
  );
  assert.equal(organizationCreditFromLimits(null, now).state, "unavailable");
});

test("a shown Cloud limit re-renders only when its wait, reset or notice window ends", () => {
  const at = 1_000_000;
  const limit = (retryAfterMs, resetsAt) => ({
    kind: "rate-limited",
    retryAfterMs,
    resetsAt,
  });
  assert.equal(serviceLimitNextChange(limit(30_000, null), at, at), 30_000);
  assert.equal(
    serviceLimitNextChange(limit(30_000, null), at, at + 29_500),
    1000,
  );
  assert.equal(
    serviceLimitNextChange(limit(30_000, null), at, at + 30_000),
    null,
  );
  // The earlier of the wait and the reset, then the reset alone once the wait has passed.
  assert.equal(
    serviceLimitNextChange(limit(30_000, at + 90_000), at, at),
    30_000,
  );
  assert.equal(
    serviceLimitNextChange(limit(30_000, at + 90_000), at, at + 40_000),
    50_000,
  );
  // A reset days away is checked again within an hour, not scheduled days ahead.
  assert.equal(
    serviceLimitNextChange(limit(null, at + 3 * 86_400_000), at, at),
    3_600_000,
  );
  // A limit with neither time is shown for one minute.
  assert.equal(
    serviceLimitNextChange(limit(null, null), at, at + 10_000),
    50_000,
  );
  assert.equal(
    serviceLimitNextChange(limit(null, null), at, at + 60_000),
    null,
  );
});
