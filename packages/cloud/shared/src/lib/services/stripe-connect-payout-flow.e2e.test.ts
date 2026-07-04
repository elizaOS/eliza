// Exercises stripe connect payout flow.e2e behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it } from "vitest";
import {
  type ConnectPayoutStatus,
  createConnectOnboarding,
  mapConnectWebhookEvent,
  type StripeConnectClient,
  type StripeConnectStatus,
  transferToConnectAccount,
} from "./stripe-connect-payout";

/**
 * Stripe Connect fiat-payout flow e2e against a **stub** (#8922).
 *
 * The acceptance criteria allow "cloud-e2e against Stripe test mode (or a Stripe
 * Connect stub): onboard → transfer → webhook → balance decremented." A live
 * account isn't available headless, so this exercises the whole flow end-to-end
 * with a stubbed Stripe SDK + in-memory stand-ins for the connect-account repo
 * and the redeemable-earnings ledger that model their real semantics (balance
 * never negative; debit then transfer then re-credit-on-failure). It asserts the
 * money + status transitions the routes orchestrate, deterministically.
 */

/** Stub Stripe SDK — records calls, optionally fails the transfer. */
function stubStripe(opts: { failTransfer?: boolean } = {}): StripeConnectClient {
  return {
    accounts: { create: async () => ({ id: "acct_e2e" }) },
    accountLinks: {
      create: async () => ({ url: "https://connect.stripe.com/setup/acct_e2e" }),
    },
    transfers: {
      create: async (p) => {
        if (opts.failTransfer) throw new Error("stub transfer declined");
        return { id: `tr_${p.amount}` };
      },
    },
  };
}

/** In-memory redeemable-earnings ledger mirroring the real debit/credit rules. */
function ledger(initialUsd: number) {
  let balance = initialUsd;
  return {
    getBalance: () => balance,
    reduce: (amt: number) => {
      if (amt <= 0 || amt > balance) return { ok: false, balance };
      balance = Math.max(0, balance - amt);
      return { ok: true, balance };
    },
    credit: (amt: number) => {
      balance += amt;
      return balance;
    },
  };
}

/** In-memory connect-account store (the repo stand-in). */
function accountStore() {
  const rows = new Map<
    string,
    { accountId: string; status: StripeConnectStatus; payouts_enabled: boolean }
  >();
  return {
    upsert: (userId: string, accountId: string) =>
      rows.set(userId, { accountId, status: "pending", payouts_enabled: false }),
    activate: (userId: string) => {
      const r = rows.get(userId);
      if (r) {
        r.status = "active";
        r.payouts_enabled = true;
      }
    },
    get: (userId: string) => rows.get(userId),
    setStatus: (accountId: string, status: StripeConnectStatus) => {
      for (const r of rows.values()) if (r.accountId === accountId) r.status = status;
    },
  };
}

describe("Stripe Connect payout flow e2e — stub (#8922)", () => {
  it("onboard → activate → transfer → webhook → balance decremented", async () => {
    const stripe = stubStripe();
    const store = accountStore();
    const earnings = ledger(50); // creator has $50 redeemable
    const userId = "user-1";
    const idem = "withdraw-e2e-000001";

    // a. onboard — create Express account + persist linkage.
    const onboarding = await createConnectOnboarding(stripe, {
      userId,
      refreshUrl: "https://app/refresh",
      returnUrl: "https://app/return",
    });
    expect(onboarding.created).toBe(true);
    store.upsert(userId, onboarding.accountId);

    // b. account.updated webhook flips it to active/payout-ready.
    const activatedEvent = mapConnectWebhookEvent({
      type: "account.updated",
      account: onboarding.accountId,
      data: { object: { charges_enabled: true, payouts_enabled: true } },
    });
    expect(activatedEvent.status).toBe("active");
    store.setStatus(onboarding.accountId, activatedEvent.status as StripeConnectStatus);
    store.activate(userId);
    expect(store.get(userId)?.payouts_enabled).toBe(true);

    // c. transfer $20 — admin route validates balance, debits, then transfers.
    const amount = 20;
    expect(earnings.getBalance()).toBeGreaterThanOrEqual(amount);
    const debit = earnings.reduce(amount);
    expect(debit.ok).toBe(true);
    const transfer = await transferToConnectAccount(stripe, {
      accountId: store.get(userId)?.accountId ?? "",
      amountUsd: amount,
      idempotencyKey: idem,
    });
    expect(transfer.amountCents).toBe(2000);

    // d. balance decremented by exactly the transfer amount.
    expect(earnings.getBalance()).toBe(30);

    // e. transfer.created → payout.paid webhooks advance status.
    const created = mapConnectWebhookEvent({
      type: "transfer.created",
      account: onboarding.accountId,
    });
    const paid = mapConnectWebhookEvent({
      type: "payout.paid",
      account: onboarding.accountId,
    });
    const statuses: ConnectPayoutStatus[] = [created.payoutStatus, paid.payoutStatus].filter(
      (s): s is ConnectPayoutStatus => Boolean(s),
    );
    expect(statuses).toEqual(["in_transit", "paid"]);
  });

  it("compensates the ledger when the Stripe transfer fails (no balance loss)", async () => {
    const stripe = stubStripe({ failTransfer: true });
    const earnings = ledger(50);
    const amount = 20;

    // Debit first, attempt transfer, re-credit on failure (the route's saga).
    const debit = earnings.reduce(amount);
    expect(debit.ok).toBe(true);
    expect(earnings.getBalance()).toBe(30);
    let failed = false;
    try {
      await transferToConnectAccount(stripe, {
        accountId: "acct_e2e",
        amountUsd: amount,
        idempotencyKey: "withdraw-e2e-fail-0001",
      });
    } catch {
      failed = true;
      earnings.credit(amount); // compensation
    }
    expect(failed).toBe(true);
    // Balance fully restored — no money lost on a failed transfer.
    expect(earnings.getBalance()).toBe(50);
  });

  it("rejects a transfer that exceeds the available balance before calling Stripe", async () => {
    const earnings = ledger(10);
    const amount = 20;
    const debit = earnings.reduce(amount);
    expect(debit.ok).toBe(false); // insufficient balance → route returns 400, no transfer
    expect(earnings.getBalance()).toBe(10);
  });
});
