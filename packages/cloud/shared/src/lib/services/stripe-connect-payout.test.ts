// Exercises stripe connect payout behavior with deterministic cloud-shared lib fixtures.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectStatusFromCapabilities,
  createConnectOnboarding,
  mapConnectWebhookEvent,
  type StripeConnectClient,
  transferToConnectAccount,
  usdToStripeCents,
} from "./stripe-connect-payout";

/** Mock Stripe SDK subset — records calls, returns canned ids. */
function mockStripe(): StripeConnectClient & {
  calls: { accounts: unknown[]; links: unknown[]; transfers: unknown[] };
} {
  const calls = { accounts: [] as unknown[], links: [] as unknown[], transfers: [] as unknown[] };
  return {
    calls,
    accounts: {
      create: async (p) => {
        calls.accounts.push(p);
        return { id: "acct_123" };
      },
    },
    accountLinks: {
      create: async (p) => {
        calls.links.push(p);
        return { url: "https://connect.stripe.com/setup/acct_123" };
      },
    },
    transfers: {
      create: async (p, o) => {
        calls.transfers.push({ p, o });
        return { id: "tr_123" };
      },
    },
  };
}

describe("createConnectOnboarding (#8922)", () => {
  it("creates an Express account + onboarding link on first onboard", async () => {
    const stripe = mockStripe();
    const out = await createConnectOnboarding(stripe, {
      userId: "u1",
      email: "creator@example.com",
      refreshUrl: "https://app/refresh",
      returnUrl: "https://app/return",
    });
    expect(out).toMatchObject({
      accountId: "acct_123",
      onboardingUrl: "https://connect.stripe.com/setup/acct_123",
      created: true,
    });
    expect(stripe.calls.accounts[0]).toMatchObject({
      type: "express",
      email: "creator@example.com",
      metadata: { userId: "u1" },
    });
    expect(stripe.calls.links[0]).toMatchObject({
      account: "acct_123",
      type: "account_onboarding",
    });
  });

  it("reuses an existing account (no new account created)", async () => {
    const stripe = mockStripe();
    const out = await createConnectOnboarding(stripe, {
      userId: "u1",
      refreshUrl: "r",
      returnUrl: "ret",
      existingAccountId: "acct_existing",
    });
    expect(out.created).toBe(false);
    expect(out.accountId).toBe("acct_existing");
    expect(stripe.calls.accounts).toHaveLength(0);
    expect(stripe.calls.links[0]).toMatchObject({ account: "acct_existing" });
  });
});

describe("usdToStripeCents", () => {
  it("rounds USD to integer cents", () => {
    expect(usdToStripeCents(14.95)).toBe(1495);
    expect(usdToStripeCents(0.1)).toBe(10);
    expect(usdToStripeCents(99.999)).toBe(10000);
  });

  it("rejects non-positive / non-finite amounts", () => {
    expect(() => usdToStripeCents(0)).toThrow();
    expect(() => usdToStripeCents(-5)).toThrow();
    expect(() => usdToStripeCents(Number.NaN)).toThrow();
  });
});

describe("transferToConnectAccount (#8922)", () => {
  it("transfers cents to the connected account with an idempotency key", async () => {
    const stripe = mockStripe();
    const out = await transferToConnectAccount(stripe, {
      accountId: "acct_123",
      amountUsd: 25,
      idempotencyKey: "withdraw-abc",
      metadata: { withdrawalId: "w1" },
    });
    expect(out).toEqual({ transferId: "tr_123", amountCents: 2500 });
    const call = stripe.calls.transfers[0] as {
      p: { amount: number; currency: string; destination: string };
      o: { idempotencyKey: string };
    };
    expect(call.p).toMatchObject({
      amount: 2500,
      currency: "usd",
      destination: "acct_123",
    });
    expect(call.o.idempotencyKey).toBe("withdraw-abc");
  });

  it("rejects an invalid amount before calling Stripe", async () => {
    const stripe = mockStripe();
    await expect(
      transferToConnectAccount(stripe, {
        accountId: "acct_123",
        amountUsd: 0,
        idempotencyKey: "k",
      }),
    ).rejects.toThrow();
    expect(stripe.calls.transfers).toHaveLength(0);
  });
});

describe("connectStatusFromCapabilities", () => {
  it("maps capability flags to a status", () => {
    expect(connectStatusFromCapabilities({ charges_enabled: true, payouts_enabled: true })).toBe(
      "active",
    );
    expect(
      connectStatusFromCapabilities({
        charges_enabled: false,
        payouts_enabled: false,
        requirementsDue: true,
      }),
    ).toBe("restricted");
    expect(connectStatusFromCapabilities({ charges_enabled: false, payouts_enabled: false })).toBe(
      "pending",
    );
    expect(
      connectStatusFromCapabilities({
        charges_enabled: true,
        payouts_enabled: true,
        disabled: true,
      }),
    ).toBe("disabled");
  });
});

describe("mapConnectWebhookEvent (#8922)", () => {
  it("advances payout status on transfer.created / payout.paid", () => {
    expect(mapConnectWebhookEvent({ type: "transfer.created", account: "acct_1" })).toMatchObject({
      accountId: "acct_1",
      payoutStatus: "in_transit",
      ignored: false,
    });
    expect(mapConnectWebhookEvent({ type: "payout.paid", account: "acct_1" })).toMatchObject({
      payoutStatus: "paid",
      ignored: false,
    });
  });

  it("refreshes account status AND surfaces the capability booleans on account.updated (#11172)", () => {
    const out = mapConnectWebhookEvent({
      type: "account.updated",
      account: "acct_1",
      data: { object: { charges_enabled: true, payouts_enabled: true } },
    });
    expect(out.status).toBe("active");
    // #11172: the booleans MUST be returned so the route persists them — the
    // payout gate reads payouts_enabled directly (defaults false). Deriving
    // status alone left every account non-payout-ready forever.
    expect(out.chargesEnabled).toBe(true);
    expect(out.payoutsEnabled).toBe(true);
  });

  it("surfaces false capabilities too (payouts not yet enabled → column stays false, truthfully) (#11172)", () => {
    const out = mapConnectWebhookEvent({
      type: "account.updated",
      account: "acct_1",
      data: { object: { charges_enabled: true, payouts_enabled: false } },
    });
    expect(out.chargesEnabled).toBe(true);
    expect(out.payoutsEnabled).toBe(false);
  });

  it("ignores unrelated event types", () => {
    expect(mapConnectWebhookEvent({ type: "customer.created" }).ignored).toBe(true);
  });
});

describe("migration 0150 (#8922)", () => {
  const migrationsDir = join(import.meta.dirname, "../../db/migrations");
  it("creates the table + enum and is registered in the journal", () => {
    const sql = readFileSync(join(migrationsDir, "0150_stripe_connect_accounts.sql"), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "stripe_connect_accounts"/);
    expect(sql).toMatch(/CREATE TYPE "stripe_connect_status"/);
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((e) => e.tag === "0150_stripe_connect_accounts")).toBe(true);
    expect(existsSync(join(migrationsDir, "0150_stripe_connect_accounts.sql"))).toBe(true);
  });
});
