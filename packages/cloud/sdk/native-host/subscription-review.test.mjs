import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createCloudRoutes } from "./cloud-services.mjs";
import { projectRenewalReview } from "./subscription-review.mjs";

const id = "11111111-1111-4111-8111-111111111111",
  commandId = "22222222-2222-4222-8222-222222222222";
const policy = {
  projectAccountAccess: () => ({ state: "active" }),
  requireNonSensitiveText() {},
  pickMessage: (x) => x,
  fundingError: () => new Error("Unavailable"),
  planKeys: ["independent_plan"],
  planCurrency: "usd",
  planInterval: "month",
  speechLanguage: null,
  providerDefaultVoice: true,
  multipartPrefix: "independent-host",
};
const terms = (now = Date.now()) => ({
  kind: "renewal_estimate",
  subscriptionId: id,
  expectedSubscriptionRevision: "3",
  planKey: "independent_plan",
  catalogVersion: "catalog1",
  currency: "usd",
  interval: "month",
  intervalCount: 1,
  baseAmountCents: 1000,
  subtotalCents: 1000,
  discountCents: 100,
  taxCents: 90,
  totalCents: 990,
  startingBalanceCents: -10,
  amountDueCents: 980,
  renewalAt: new Date(now + 86400000).toISOString(),
  nextPeriodEnd: new Date(now + 86400000 * 31).toISOString(),
  observedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 60000).toISOString(),
  termsDigest: "a".repeat(64),
});
test("renewal projection preserves displayed financial terms and rejects stale or mismatched contracts", () => {
  const now = Date.now(),
    v = terms(now);
  assert.deepEqual(
    projectRenewalReview({ ...v, providerSecret: "hidden" }, policy, now),
    v,
  );
  for (const change of [
    { expiresAt: new Date(now).toISOString() },
    { expiresAt: new Date(now + 60001).toISOString() },
    { observedAt: new Date(now + 6000).toISOString() },
    { currency: "eur" },
    { planKey: "other" },
    { interval: "year" },
    { baseAmountCents: 0 },
    { startingBalanceCents: 1.5 },
    { totalCents: 999 },
    { termsDigest: "bad" },
    { expectedSubscriptionRevision: "9007199254740992" },
    { renewalAt: new Date(now).toISOString() },
    { nextPeriodEnd: v.renewalAt },
  ])
    assert.throws(
      () => projectRenewalReview({ ...v, ...change }, policy, now),
      /unavailable/,
    );
});
test("renewal projection accepts inclusive, exclusive and mixed tax totals the server verified", () => {
  const now = Date.now();
  // The server checks total = subtotal - discount + exclusive tax and
  // reports all tax, inclusive and exclusive, in taxCents.
  for (const amounts of [
    { subtotalCents: 1000, discountCents: 0, taxCents: 167, totalCents: 1000 },
    { subtotalCents: 1000, discountCents: 100, taxCents: 90, totalCents: 990 },
    { subtotalCents: 1000, discountCents: 100, taxCents: 90, totalCents: 940 },
  ]) {
    const v = { ...terms(now), ...amounts };
    assert.deepEqual(projectRenewalReview(v, policy, now), v);
  }
  for (const totalCents of [899, 991])
    assert.throws(
      () => projectRenewalReview({ ...terms(now), totalCents }, policy, now),
      /unavailable/,
    );
});
test("private native lifecycle binds reviewed terms, supports restart and failed retry, and recovers without dispatch", async (t) => {
  let authorized = false,
    action = "undo",
    status = "OUTCOME_UNKNOWN",
    digest = "a".repeat(64),
    mutations = [],
    reads = 0,
    malformed = false,
    failResponse = false;
  const dto = () => ({
    commandId,
    subscriptionId: id,
    status,
    expectedSubscriptionRevision: "3",
    resultSubscriptionRevision: status === "APPLIED" ? "4" : null,
    privateProvider: "hidden",
  });
  const start = async () => {
    const routes = createCloudRoutes({
      hostPolicy: {
        ...policy,
        createNativeCloudAuth: () => ({
          billingAuthority: async () =>
            authorized
              ? {
                  token: "synthetic-billing-session",
                  expiresAt: new Date(Date.now() + 60000).toISOString(),
                }
              : null,
        }),
      },
      pendingCredentialStore: { read: async () => null },
      initialApiKey: "synthetic-inference-key",
      fetchImpl: async (url, init) => {
        assert.equal(
          init.headers.Authorization,
          "Bearer synthetic-billing-session",
        );
        const u = new URL(url),
          path = u.pathname;
        if (path === "/api/v1/subscriptions/cancel/undo/review") {
          reads++;
          assert.equal(init.method, "GET");
          assert.equal(u.searchParams.get("subscriptionId"), id);
          assert.equal(u.searchParams.get("expectedSubscriptionRevision"), "3");
          return Response.json({
            success: true,
            data: {
              ...terms(),
              termsDigest: digest,
              subscriptionId: malformed ? commandId : id,
              providerSecret: "hidden",
            },
          });
        }
        if (path === "/api/v1/billing/limits")
          return Response.json({
            success: true,
            data: {
              v2: {
                snapshotCompletedAt: new Date().toISOString(),
                subscription: {
                  status: "available",
                  value: {
                    subscriptionId: id,
                    planKey: "independent_plan",
                    state: "active",
                    currentPeriodEnd: new Date(
                      Date.now() + 86400000,
                    ).toISOString(),
                    cancelAtPeriodEnd: action === "undo",
                    pendingPlanKey: null,
                    dunningStartedAt: null,
                    graceExpiresAt: null,
                    cancellationControl: {
                      action,
                      method: "POST",
                      endpoint:
                        "/api/v1/subscriptions/cancel" +
                        (action === "undo" ? "/undo" : ""),
                      subscriptionId: id,
                      expectedSubscriptionRevision: 3,
                      eligible: true,
                      blockers: [],
                    },
                  },
                },
              },
            },
          });
        if (
          path === "/api/v1/subscriptions/cancel/undo/confirm" ||
          path === "/api/v1/subscriptions/cancel"
        ) {
          assert.equal(init.method, "POST");
          const input = JSON.parse(init.body);
          mutations.push({ path, ...input });
          if (action === "undo")
            assert.equal(input.expectedRenewalTermsDigest, digest);
          if (failResponse) throw Error("Lost synthetic response");
          return Response.json({ success: true, data: dto() });
        }
        if (path.endsWith("/" + commandId)) {
          assert.equal(init.method, "GET");
          return Response.json({ success: true, data: dto() });
        }
        if (path === "/api/v1/subscriptions/commands") {
          assert.equal(init.method, "GET");
          assert.equal(u.searchParams.get("limit"), "20");
          return Response.json({
            success: true,
            data: {
              observedAt: new Date().toISOString(),
              items:
                status === "OUTCOME_UNKNOWN"
                  ? [{ ...dto(), kind: "resume" }]
                  : [],
              nextCursor: null,
            },
          });
        }
        throw Error("Unexpected route " + path);
      },
    });
    const server = http.createServer((req, res) =>
      routes(req, res, new URL(req.url, "http://localhost")),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    return async (path, input = {}, method = "POST") => {
      const r = await fetch(
        `http://127.0.0.1:${server.address().port}/cloud/account/subscription/${path}`,
        {
          method,
          headers: { "Content-Type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
        },
      );
      return { status: r.status, data: await r.json() };
    };
  };
  let post = await start();
  const reviewInput = { subscriptionId: id, revision: 3 };
  assert.equal((await post("renewal-review", reviewInput)).status, 428);
  authorized = true;
  const review = await post("renewal-review", reviewInput);
  assert.equal(review.status, 200);
  assert.equal(review.data.termsDigest, digest);
  assert.ok(!JSON.stringify(review).includes("hidden"));
  assert.equal(mutations.length, 0);
  malformed = true;
  assert.equal((await post("renewal-review", reviewInput)).status, 502);
  malformed = false;
  assert.equal((await post("undo", reviewInput)).status, 400);
  assert.equal(
    (await post("renewal-review", { ...reviewInput, token: "renderer" }))
      .status,
    400,
  );
  assert.equal(
    (await post("undo", { ...reviewInput, expectedRenewalTermsDigest: "x" }))
      .status,
    400,
  );
  const input = () => ({ ...reviewInput, expectedRenewalTermsDigest: digest });
  assert.equal((await post("undo", input())).data.status, "OUTCOME_UNKNOWN");
  const first = mutations[0].idempotencyKey;
  post = await start();
  await post("undo", input());
  assert.equal(mutations[1].idempotencyKey, first);
  const count = mutations.length;
  assert.equal((await post("pending")).data.items[0].action, "undo");
  assert.equal(
    (await post("status", { action: "undo", commandId })).data.status,
    "OUTCOME_UNKNOWN",
  );
  assert.equal(mutations.length, count);
  for (const previous of [
    "PREPARED",
    "OUTCOME_UNKNOWN",
    "APPLIED",
    "SUPERSEDED",
  ]) {
    status = previous;
    assert.equal(
      (await post("undo", { ...input(), retryOf: commandId })).status,
      409,
    );
  }
  status = "FAILED";
  await post("undo", { ...input(), retryOf: commandId });
  const retry = mutations.at(-1).idempotencyKey;
  assert.notEqual(retry, first);
  post = await start();
  await post("undo", { ...input(), retryOf: commandId });
  assert.equal(mutations.at(-1).idempotencyKey, retry);
  // A failed server command whose response was lost is absent from pending.
  // Explicit approval of changed terms must not reuse its inaccessible old key.
  failResponse = true;
  await post("undo", input());
  failResponse = false;
  assert.deepEqual((await post("pending")).data.items, []);
  digest = "b".repeat(64);
  assert.equal(
    (await post("renewal-review", reviewInput)).data.termsDigest,
    digest,
  );
  await post("undo", input());
  assert.notEqual(mutations.at(-1).idempotencyKey, first);
  action = "cancel";
  assert.equal((await post("cancel", input())).status, 400);
  await post("cancel", reviewInput);
  assert.equal(mutations.at(-1).expectedRenewalTermsDigest, undefined);
  assert.notEqual(mutations.at(-1).idempotencyKey, first);
  authorized = false;
  const before = mutations.length;
  assert.equal((await post("undo", input())).status, 428);
  assert.equal(
    (await post("status", { action: "undo", commandId })).status,
    428,
  );
  assert.equal(mutations.length, before);
  assert.ok(reads >= 3);
});

test("portal projects only a provider-scoped URL and service-only hosts cannot access billing", async (t) => {
  let destination = "https://billing.stripe.com/p/session/synthetic",
    calls = 0;
  const start = async (accountBilling) => {
    const routes = createCloudRoutes({
      hostPolicy: {
        ...policy,
        accountBilling,
        createNativeCloudAuth: () => ({
          billingAuthority: async () => ({
            token: "synthetic-billing-session",
            expiresAt: Date.now() + 60000,
          }),
        }),
      },
      pendingCredentialStore: { read: async () => null },
      fetchImpl: async (url, init) => {
        calls++;
        assert.equal(new URL(url).pathname, "/api/v1/subscriptions/portal");
        assert.equal(
          init.headers.Authorization,
          "Bearer synthetic-billing-session",
        );
        assert.equal(init.body, "{}");
        return Response.json({
          data: { url: destination, privateProvider: "hidden" },
        });
      },
    });
    const server = http.createServer((req, res) =>
      routes(req, res, new URL(req.url, "http://localhost")),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    return async (path, input = {}, method = "POST") => {
      const r = await fetch(
        `http://127.0.0.1:${server.address().port}/cloud/account/${path}`,
        {
          method,
          headers: { "Content-Type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
        },
      );
      return { status: r.status, data: await r.json() };
    };
  };
  let post = await start(true);
  assert.deepEqual((await post("portal")).data, { url: destination });
  assert.equal(
    (await post("portal", { returnUrl: "https://other.test" })).status,
    400,
  );
  assert.equal(calls, 1);
  for (const url of [
    "https://billing.stripe.com.other.test/p/session/a",
    "http://billing.stripe.com/p/session/a",
    "https://name@billing.stripe.com/p/session/a",
    "https://billing.stripe.com/other/a",
  ]) {
    destination = url;
    assert.equal((await post("portal")).status, 502);
  }
  post = await start(false);
  const before = calls;
  for (const path of [
    "portal",
    "subscription/renewal-review",
    "subscription/undo",
    "subscription/cancel",
    "subscription/status",
    "subscription/pending",
  ])
    assert.equal((await post(path)).status, 404);
  assert.equal((await post("management", {}, "GET")).status, 404);
  assert.equal(calls, before);
});
