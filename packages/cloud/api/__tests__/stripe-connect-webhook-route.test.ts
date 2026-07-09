/**
 * Exercises the Stripe Connect webhook route with deterministic Worker route fixtures.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
// The REAL Stripe SDK — used (un-mocked) in the "real crypto" suite below to
// prove the actual signature verification the route relies on rejects forgeries.
import Stripe from "stripe";
// Capture audit emits through the REAL singleton (setAuditDispatcher) rather
// than mock.module'ing getAuditDispatcher — a module mock is process-global and
// would pin getAuditDispatcher to this fake for every later suite.
import {
  initAuditDispatcher,
  setAuditDispatcher,
} from "@/api-app/services/audit-dispatcher-singleton";
// Spread into the partial logger mock below — mock.module is process-global, so
// dropping a real export breaks later suites that import it.
import * as loggerActual from "@/lib/utils/logger";

const constructEventAsync = mock();
const emitAudit = mock(async () => undefined);
const updateByAccountId = mock(async () => undefined);
// Controllable so a test can assert the Stripe-not-configured fail-closed path.
let stripeConfigured = true;

mock.module(
  "@elizaos/cloud-shared/db/repositories/stripe-connect-accounts",
  () => ({
    stripeConnectAccountsRepository: { updateByAccountId },
  }),
);

// NOTE: mapConnectWebhookEvent is intentionally NOT mocked — the test exercises
// the real pure mapping so a regression there is caught here too.

// The route dedupes on event.id via webhookEventsRepository.tryCreate (#12227
// L5). Stub it as a first-time delivery so these mapping/persist tests run;
// replay dedupe itself is covered in the sibling dedupe.test.ts.
mock.module("@elizaos/cloud-shared/db/repositories/webhook-events", () => ({
  webhookEventsRepository: {
    tryCreate: mock(async () => ({ created: true, event: { id: "evt" } })),
  },
}));

mock.module("@/lib/stripe", () => ({
  isStripeConfigured: () => stripeConfigured,
  requireStripe: () => ({ webhooks: { constructEventAsync } }),
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

const { default: app } = await import(
  "../v1/earnings/payout/stripe-connect/webhook/route"
);

const env = { STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test" };

function connectRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://api.example.test/", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const accountUpdatedEvent = {
  id: "evt_acct",
  type: "account.updated",
  account: "acct_creator_1",
  data: { object: { charges_enabled: true, payouts_enabled: true } },
};

describe("Stripe Connect payout webhook route", () => {
  beforeEach(() => {
    stripeConfigured = true;
    constructEventAsync.mockReset();
    constructEventAsync.mockResolvedValue(accountUpdatedEvent);
    emitAudit.mockClear();
    updateByAccountId.mockReset();
    updateByAccountId.mockResolvedValue(undefined);
    setAuditDispatcher({
      emit: emitAudit,
    } as unknown as Parameters<typeof setAuditDispatcher>[0]);
  });

  afterAll(() => {
    setAuditDispatcher(initAuditDispatcher());
  });

  test("rejects 400 with no Stripe signature, before any verify or DB write", async () => {
    const res = await app.fetch(connectRequest(accountUpdatedEvent), env);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "No signature provided",
    });
    expect(constructEventAsync).not.toHaveBeenCalled();
    expect(updateByAccountId).not.toHaveBeenCalled();
  });

  test("fail-closes 500 when the Connect signing secret is not configured", async () => {
    const res = await app.fetch(
      connectRequest(accountUpdatedEvent, { "stripe-signature": "sig" }),
      {}, // no STRIPE_CONNECT_WEBHOOK_SECRET
    );
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Webhook configuration error",
    });
    expect(constructEventAsync).not.toHaveBeenCalled();
    expect(updateByAccountId).not.toHaveBeenCalled();
  });

  test("fail-closes 500 when Stripe itself is not configured", async () => {
    stripeConfigured = false;
    const res = await app.fetch(
      connectRequest(accountUpdatedEvent, { "stripe-signature": "sig" }),
      env,
    );
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Stripe configuration error",
    });
    expect(constructEventAsync).not.toHaveBeenCalled();
    expect(updateByAccountId).not.toHaveBeenCalled();
  });

  test("rejects 400 and audit-logs a denial on invalid signature — no DB write", async () => {
    constructEventAsync.mockRejectedValueOnce(
      new Error("No signatures found matching the expected signature"),
    );
    const res = await app.fetch(
      connectRequest(accountUpdatedEvent, {
        "stripe-signature": "bad",
        "x-forwarded-for": "198.51.100.9, 10.0.0.1",
      }),
      env,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Webhook signature verification failed",
    });
    expect(emitAudit).toHaveBeenCalledWith({
      actor: { type: "system", id: "stripe-connect-webhook" },
      action: "redemption.payout",
      result: "denied",
      resource: { type: "webhook", id: "stripe-connect" },
      ip: "198.51.100.9",
      request_id: undefined,
      metadata: { provider: "stripe-connect", reason: "invalid_signature" },
    });
    expect(updateByAccountId).not.toHaveBeenCalled();
  });

  test("classifies a stale-timestamp failure distinctly in the audit log", async () => {
    constructEventAsync.mockRejectedValueOnce(
      new Error("Timestamp outside the tolerance zone"),
    );
    const res = await app.fetch(
      connectRequest(accountUpdatedEvent, { "stripe-signature": "old" }),
      env,
    );
    expect(res.status).toBe(400);
    expect(emitAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "redemption.payout",
        result: "denied",
        metadata: { provider: "stripe-connect", reason: "stale_timestamp" },
      }),
    );
    expect(updateByAccountId).not.toHaveBeenCalled();
  });

  test("applies the connect-account status for a verified account.updated event", async () => {
    const res = await app.fetch(
      connectRequest(accountUpdatedEvent, { "stripe-signature": "good" }),
      env,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    // account.updated with charges+payouts enabled => "active", AND the raw
    // capability booleans are persisted (#11172): the payout transfer gate reads
    // payouts_enabled directly (defaults false), so storing status alone left
    // every account non-payout-ready forever. The column must be written true.
    expect(updateByAccountId).toHaveBeenCalledWith("acct_creator_1", {
      status: "active",
      charges_enabled: true,
      payouts_enabled: true,
    });
    expect(emitAudit).not.toHaveBeenCalled();
  });

  test("verifies a transfer.created event and advances payout status (no status patch)", async () => {
    constructEventAsync.mockResolvedValueOnce({
      id: "evt_transfer",
      type: "transfer.created",
      account: "acct_creator_1",
      data: { object: {} },
    });
    const res = await app.fetch(
      connectRequest({}, { "stripe-signature": "good" }),
      env,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(updateByAccountId).toHaveBeenCalledWith("acct_creator_1", {});
  });

  test("ignores verified-but-irrelevant event types without touching the DB", async () => {
    constructEventAsync.mockResolvedValueOnce({
      id: "evt_other",
      type: "customer.created",
      data: { object: {} },
    });
    const res = await app.fetch(
      connectRequest({}, { "stripe-signature": "good" }),
      env,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, ignored: true });
    expect(updateByAccountId).not.toHaveBeenCalled();
  });
});

// Real cryptography — no mock. Proves the exact verification primitive the route
// now calls (`stripe.webhooks.constructEventAsync`) accepts only a payload
// signed with the Connect secret and rejects the forged/tampered events the
// issue describes (#10117). Signature ops are local HMAC-SHA256 — no network.
describe("Stripe Connect webhook — real signature verification (no mock)", () => {
  const realStripe = new Stripe("sk_test_dummy_for_signature_only", {
    apiVersion: "2026-05-27.dahlia",
  });
  const secret = "whsec_connect_realtest";
  const payload = JSON.stringify(accountUpdatedEvent);

  test("accepts a correctly-signed Connect event", async () => {
    const header = await realStripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret,
    });
    const event = await realStripe.webhooks.constructEventAsync(
      payload,
      header,
      secret,
    );
    expect(event.type).toBe("account.updated");
    expect(event.account).toBe("acct_creator_1");
  });

  test("rejects a forged body re-using a valid signature (tamper attack)", async () => {
    const header = await realStripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret,
    });
    const tampered = `${payload.slice(0, -1)}, "payouts_enabled": true}`;
    await expect(
      realStripe.webhooks.constructEventAsync(tampered, header, secret),
    ).rejects.toThrow();
  });

  test("rejects an event signed with the wrong secret (no shared secret)", async () => {
    const header = await realStripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: "whsec_attacker_secret",
    });
    await expect(
      realStripe.webhooks.constructEventAsync(payload, header, secret),
    ).rejects.toThrow();
  });

  test("rejects an event with no signature header at all", async () => {
    await expect(
      realStripe.webhooks.constructEventAsync(payload, "", secret),
    ).rejects.toThrow();
  });

  test("rejects a stale timestamp outside the tolerance window", async () => {
    const staleTs = Math.floor(Date.parse("2020-01-01T00:00:00Z") / 1000);
    const header = await realStripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret,
      timestamp: staleTs,
    });
    await expect(
      realStripe.webhooks.constructEventAsync(payload, header, secret, 300),
    ).rejects.toThrow(/timestamp/i);
  });
});
