import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createCloudRoutes } from "./cloud-services.mjs";
import {
  projectPendingPlanChanges,
  projectPlanChangeCommand,
  projectPlanChangeQuote,
  projectUpgradePayment,
} from "./plan-change.mjs";

const id = "11111111-1111-4111-8111-111111111111",
  quoteId = "22222222-2222-4222-8222-222222222222",
  commandId = "33333333-3333-4333-8333-333333333333";
const policy = {
  projectAccountAccess: () => ({ state: "active" }),
  requireNonSensitiveText() {},
  pickMessage: (x) => x,
  fundingError: () => new Error("Unavailable"),
  planKeys: ["host_basic", "host_extra"],
  planCurrency: "usd",
  planInterval: "month",
  speechLanguage: null,
  providerDefaultVoice: true,
  multipartPrefix: "independent-host",
};
const invoice = () => ({
  amountDueCents: 900,
  subtotalCents: 1000,
  discountCents: 100,
  taxCents: 0,
  totalCents: 900,
  startingBalanceCents: 0,
  providerSecret: "hidden",
});
function quote(action = "upgrade", now = Date.now()) {
  const end = new Date(now + 86400000).toISOString();
  return {
    quoteId,
    providerSecret: "hidden",
    review: {
      kind: `${action}_estimate`,
      subscriptionId: id,
      expectedSubscriptionRevision: "3",
      sourcePlanKey: action === "upgrade" ? "host_basic" : "host_extra",
      targetPlanKey: action === "upgrade" ? "host_extra" : "host_basic",
      catalogVersion: "catalog-host",
      currency: "usd",
      currentPeriodStart: new Date(now - 86400000).toISOString(),
      currentPeriodEnd: end,
      targetBaseAmountCents: 1000,
      targetAllowanceUsd: "10.000000",
      recurringEstimate: invoice(),
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
      ...(action === "upgrade"
        ? {
            prorationDate: Math.floor(now / 1000),
            additionalAllowanceUsd: "1.000000",
            dueNow: invoice(),
          }
        : { effectiveAt: end, amountDueNowCents: 0 }),
      providerSecret: "hidden",
    },
  };
}
function command(action = "upgrade", status = "OUTCOME_UNKNOWN") {
  return {
    commandId,
    subscriptionId: id,
    targetPlanKey: action === "upgrade" ? "host_extra" : "host_basic",
    status,
    expectedSubscriptionRevision: "3",
    resultSubscriptionRevision: status === "APPLIED" ? "4" : null,
    failure:
      status === "FAILED"
        ? action === "upgrade"
          ? "invoice_void"
          : "create_compensated"
        : status === "SUPERSEDED"
          ? "review_required"
          : null,
    ...(action === "upgrade"
      ? { dispatchState: "started" }
      : {
          effect: {
            kind: "schedule_configure",
            state: "observed",
            providerSecret: "hidden",
          },
        }),
    providerSecret: "hidden",
  };
}
function page() {
  return {
    observedAt: new Date().toISOString(),
    items: [
      {
        ...command(),
        kind: "upgrade",
        createdAt: new Date().toISOString(),
        lease: "active",
        source: {
          state: "current",
          currentSubscriptionRevision: "3",
          providerSecret: "hidden",
        },
      },
    ],
    nextCursor: "next_cursor",
    providerSecret: "hidden",
  };
}
function payment() {
  return {
    command: command(),
    continuation: {
      kind: "hosted_invoice",
      hostedInvoiceUrl:
        "https://invoice.stripe.com/i/acct_fixture/original?s=private",
      amountDueCents: 900,
      currency: "usd",
      paymentState: "requires_action",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      providerSecret: "hidden",
    },
  };
}
for (const action of ["upgrade", "downgrade"])
  test(`${action} review projects exact public terms using host plan policy`, () => {
    const now = Date.now(),
      v = quote(action, now),
      result = projectPlanChangeQuote(v, action, policy, now);
    assert.equal(result.quoteId, quoteId);
    assert.equal(result.review.targetPlanKey, v.review.targetPlanKey);
    assert.equal(result.review.recurringEstimate.discountCents, 100);
    assert.ok(!JSON.stringify(result).includes("hidden"));
    for (const change of [
      { subscriptionId: "bad" },
      { targetPlanKey: "plus_monthly" },
      { sourcePlanKey: v.review.targetPlanKey },
      { expectedSubscriptionRevision: "9007199254740992" },
      { currency: "eur" },
      { targetAllowanceUsd: "1.2" },
      { expiresAt: new Date(now - 1).toISOString() },
      { expiresAt: new Date(now + 60001).toISOString() },
      { observedAt: new Date(now + 6000).toISOString() },
      { currentPeriodStart: v.review.currentPeriodEnd },
      ...(action === "upgrade"
        ? [
            { prorationDate: Math.floor(now / 1000) - 2 },
            { additionalAllowanceUsd: "-1.000000" },
          ]
        : [
            { amountDueNowCents: 1 },
            { effectiveAt: new Date(now).toISOString() },
          ]),
    ])
      assert.throws(
        () =>
          projectPlanChangeQuote(
            { ...v, review: { ...v.review, ...change } },
            action,
            policy,
            now,
          ),
        /unavailable/,
      );
  });
test("credit and tax values are retained without native recomputation of provider arithmetic", () => {
  assert.throws(() =>
    projectPlanChangeQuote(quote(), "upgrade", {
      ...policy,
      planInterval: "year",
    }),
  );
  const v = quote();
  v.review.dueNow = {
    ...invoice(),
    amountDueCents: 0,
    subtotalCents: -100,
    totalCents: -100,
    startingBalanceCents: -10,
  };
  assert.equal(
    projectPlanChangeQuote(v, "upgrade", policy).review.dueNow.subtotalCents,
    -100,
  );
  for (const value of [NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    v.review.dueNow.taxCents = value;
    assert.throws(() => projectPlanChangeQuote(v, "upgrade", policy));
  }
});
test("command states and failures are projected without provider details", () => {
  for (const action of ["upgrade", "downgrade"])
    for (const state of [
      "OUTCOME_UNKNOWN",
      "APPLIED",
      "FAILED",
      "SUPERSEDED",
    ]) {
      const result = projectPlanChangeCommand(
        command(action, state),
        action,
        policy,
      );
      assert.equal(result.status, state);
      assert.ok(!JSON.stringify(result).includes("hidden"));
    }
  for (const change of [
    { status: "SUCCEEDED" },
    { resultSubscriptionRevision: "4" },
    { failure: "raw_provider_failure" },
    { dispatchState: "completed" },
    { targetPlanKey: "foreign" },
  ])
    assert.throws(() =>
      projectPlanChangeCommand({ ...command(), ...change }, "upgrade", policy),
    );
  assert.throws(() =>
    projectPlanChangeCommand(
      { ...command("downgrade"), effect: { kind: "other", state: "observed" } },
      "downgrade",
      policy,
    ),
  );
});
test("pending pages retain source and lease state, reject malformed or duplicate commands", () => {
  const v = page(),
    result = projectPendingPlanChanges(v, policy);
  assert.equal(result.items[0].source.state, "current");
  assert.equal(result.items[0].lease, "active");
  assert.ok(!JSON.stringify(result).includes("hidden"));
  for (const change of [
    { kind: "cancel" },
    { status: "APPLIED" },
    { lease: "not_started" },
    { source: { state: "current", currentSubscriptionRevision: "4" } },
    { source: null },
    { source: { state: "unavailable", currentSubscriptionRevision: "3" } },
    { createdAt: "invalid" },
  ])
    assert.throws(() =>
      projectPendingPlanChanges(
        { ...v, items: [{ ...v.items[0], ...change }] },
        policy,
      ),
    );
  assert.throws(() =>
    projectPendingPlanChanges(
      { ...v, items: [v.items[0], v.items[0]] },
      policy,
    ),
  );
  assert.throws(() =>
    projectPendingPlanChanges({ ...v, nextCursor: "!" }, policy),
  );
  assert.throws(() =>
    projectPendingPlanChanges(
      { ...v, items: Array(21).fill(v.items[0]) },
      policy,
    ),
  );
});
test("payment continuation only exposes an unexpired original hosted invoice for unresolved payment", () => {
  const v = payment();
  assert.equal(
    projectUpgradePayment(v, policy).continuation.hostedInvoiceUrl,
    v.continuation.hostedInvoiceUrl,
  );
  assert.ok(
    !JSON.stringify(projectUpgradePayment(v, policy)).includes("hidden"),
  );
  for (const hostedInvoiceUrl of [
    "http://invoice.stripe.com/i/x",
    "https://invoice.stripe.com.evil.test/i/x",
    "https://u:p@invoice.stripe.com/i/x",
    "https://invoice.stripe.com:444/i/x",
    "https://invoice.stripe.com/i/x#secret",
    "https://invoice.stripe.com/i/",
    "https://invoice.stripe.com/i/../x",
    " https://invoice.stripe.com/i/x",
  ])
    assert.throws(() =>
      projectUpgradePayment(
        { ...v, continuation: { ...v.continuation, hostedInvoiceUrl } },
        policy,
      ),
    );
  assert.throws(() =>
    projectUpgradePayment(
      { ...v, command: command("upgrade", "APPLIED") },
      policy,
    ),
  );
  assert.throws(() =>
    projectUpgradePayment(
      {
        ...v,
        continuation: {
          ...v.continuation,
          expiresAt: new Date(0).toISOString(),
        },
      },
      policy,
    ),
  );
  assert.equal(
    projectUpgradePayment(
      { command: command("upgrade", "APPLIED"), continuation: null },
      policy,
    ).continuation,
    null,
  );
});
test("real native broker uses private sessions, stable intents and read-only restart discovery", async (t) => {
  let authorized = false,
    failResponse = false,
    switchDuring = false,
    malformed = false,
    badEnvelope = false,
    beforeStart;
  const calls = [];
  const start = async () => {
    const routes = createCloudRoutes({
      hostPolicy: {
        ...policy,
        createNativeCloudAuth: (hooks) => {
          beforeStart = hooks.beforeStart;
          return {
            billingAuthority: async () =>
              authorized
                ? {
                    token: "synthetic-billing-session",
                    expiresAt: new Date(Date.now() + 60000).toISOString(),
                  }
                : null,
          };
        },
      },
      pendingCredentialStore: { read: async () => null },
      initialApiKey: "synthetic-inference-key",
      fetchImpl: async (url, init) => {
        assert.equal(
          init.headers.Authorization,
          "Bearer synthetic-billing-session",
        );
        assert.equal(init.redirect, "error");
        const u = new URL(url),
          path = u.pathname,
          body = init.body ? JSON.parse(init.body) : null;
        calls.push({ path, method: init.method, body, query: u.search });
        if (switchDuring) {
          switchDuring = false;
          await beforeStart();
        }
        if (failResponse) {
          failResponse = false;
          throw Error("private transport failure");
        }
        const action = path.includes("/downgrade/") ? "downgrade" : "upgrade";
        let data;
        if (path.endsWith("/review")) data = quote(action);
        else if (path.endsWith("/commands")) data = page();
        else if (path.endsWith("/payment")) data = payment();
        else data = command(action);
        if (malformed) {
          if (data.review) data.review.subscriptionId = commandId;
          else data.commandId = id;
        }
        return Response.json({ success: !badEnvelope, data });
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
    return async (operation, input = {}) => {
      const r = await fetch(
        `http://127.0.0.1:${server.address().port}/cloud/account/plan-change/${operation}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      return {
        status: r.status,
        data: await r.json(),
        cache: r.headers.get("cache-control"),
      };
    };
  };
  let post = await start();
  const review = {
    kind: "upgrade",
    subscriptionId: id,
    revision: 3,
    targetPlanKey: "host_extra",
  };
  assert.equal((await post("review", review)).status, 428);
  assert.equal(calls.length, 0);
  authorized = true;
  assert.equal((await post("pending?token=renderer")).status, 400);
  for (const [op, input] of [
    ["review", { ...review, token: "renderer" }],
    ["confirm", { kind: "upgrade", quoteId, idempotencyKey: "renderer" }],
    ["status", { kind: "cancel", commandId }],
    ["pending", { cursor: "bad!" }],
    ["payment", { commandId, kind: "downgrade" }],
    ["review", { ...review, revision: 1.5 }],
  ])
    assert.equal((await post(op, input)).status, 400);
  assert.equal(calls.length, 0);
  for (const kind of ["upgrade", "downgrade"]) {
    const result = await post("review", {
      ...review,
      kind,
      targetPlanKey: kind === "upgrade" ? "host_extra" : "host_basic",
    });
    assert.equal(result.status, 200);
    assert.equal(result.cache, "no-store");
    assert.ok(!JSON.stringify(result).includes("hidden"));
  }
  badEnvelope = true;
  assert.equal((await post("review", review)).status, 502);
  badEnvelope = false;
  malformed = true;
  assert.equal((await post("review", review)).status, 502);
  malformed = false;
  const confirm = { kind: "upgrade", quoteId };
  assert.equal((await post("confirm", confirm)).status, 200);
  const first = calls.at(-1).body.idempotencyKey;
  post = await start();
  assert.equal((await post("confirm", confirm)).status, 200);
  assert.equal(calls.at(-1).body.idempotencyKey, first);
  assert.equal(
    (await post("confirm", { kind: "downgrade", quoteId })).status,
    200,
  );
  assert.notEqual(calls.at(-1).body.idempotencyKey, first);
  failResponse = true;
  const unknown = await post("confirm", confirm);
  assert.equal(unknown.status, 502);
  assert.ok(!JSON.stringify(unknown).includes("private"));
  const count = calls.length;
  assert.equal(
    (await post("pending", { cursor: "next_cursor" })).data.items[0].lease,
    "active",
  );
  assert.equal(calls.at(-1).method, "GET");
  assert.equal(
    (await post("status", { kind: "upgrade", commandId })).data.status,
    "OUTCOME_UNKNOWN",
  );
  assert.equal(calls.at(-1).method, "GET");
  assert.equal(calls.length, count + 2);
  const paid = await post("payment", { commandId });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.continuation.kind, "hosted_invoice");
  assert.equal(calls.at(-1).method, "POST");
  assert.equal(calls.at(-1).body, null);
  malformed = true;
  assert.equal(
    (await post("status", { kind: "upgrade", commandId })).status,
    502,
  );
  malformed = false;
  switchDuring = true;
  assert.equal((await post("review", review)).status, 409);
  authorized = false;
  assert.equal((await post("pending")).status, 428);
});
