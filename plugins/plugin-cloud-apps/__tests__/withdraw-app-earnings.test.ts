import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { WithdrawAppEarningsRequest } from "@elizaos/cloud-sdk";
import type { ConnectorCta } from "../src/safety.ts";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setGetAppEarnings,
  setListApps,
  setWithdrawAppEarnings,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { withdrawAppEarningsAction } = await import(
  "../src/actions/withdraw-app-earnings.ts"
);

const APP = makeApp({
  id: "id-acme",
  name: "Acme Bot",
  slug: "acme-bot",
  monetization_enabled: true,
});

const API_KEY = "eliza_test_key"; // what keyedRuntime() configures

/** Configure earnings with a withdrawable balance + threshold. */
function setBalance(withdrawableBalance: number, payoutThreshold = 25): void {
  setGetAppEarnings(() =>
    Promise.resolve({
      success: true,
      earnings: {
        summary: {
          withdrawableBalance,
          pendingBalance: 0,
          totalLifetimeEarnings: withdrawableBalance,
          totalWithdrawn: 0,
          payoutThreshold,
        },
      },
      monetization: { enabled: true },
    }),
  );
}

/** Track withdraw calls (the money-out path). */
function trackWithdrawals(): {
  calls: Array<{ id: string; request: WithdrawAppEarningsRequest }>;
} {
  const calls: Array<{ id: string; request: WithdrawAppEarningsRequest }> = [];
  setWithdrawAppEarnings((id, request) => {
    calls.push({ id, request });
    return Promise.resolve({
      success: true,
      message: "withdrawn",
      transactionId: "txn_1",
      newBalance: 0,
    });
  });
  return { calls };
}

describe("WITHDRAW_APP_EARNINGS", () => {
  beforeEach(() => {
    resetSdk();
    setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
    setBalance(100, 25);
  });

  it("validates only when a Cloud API key is present", async () => {
    expect(
      await withdrawAppEarningsAction.validate(
        keyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(true);
    expect(
      await withdrawAppEarningsAction.validate(
        unkeyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(false);
  });

  it("first ask: returns a confirm prompt + CTA and makes NO money call", async () => {
    const withdrawals = trackWithdrawals();
    const cb = captureCallback();
    const result = await withdrawAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("withdraw my Acme Bot earnings"),
      undefined,
      undefined,
      cb.fn,
    );

    // No money moved on the first ask.
    expect(withdrawals.calls).toHaveLength(0);
    expect((result?.data as { withdrawn: boolean }).withdrawn).toBe(false);
    expect(
      (result?.data as { confirmationRequired: boolean }).confirmationRequired,
    ).toBe(true);

    // Confirm prompt names the amount (defaults to the full withdrawable balance).
    const prompt = cb.calls[0]?.text ?? "";
    expect(prompt).toContain("$100.00");
    expect(prompt.toLowerCase()).toContain("reply");

    // A connector-agnostic CTA is handed back — label + https URL only.
    const cta = (result?.data as { cta: ConnectorCta }).cta;
    expect(cta.url.startsWith("https://")).toBe(true);
    expect(cta.url).toContain("/dashboard/apps/id-acme");
    expect(prompt).toContain(cta.url);

    // NO secret/credential transits the connector output.
    expect(Object.keys(cta).sort()).toEqual(["kind", "label", "url"]);
    const ctaBlob = JSON.stringify(cta);
    expect(ctaBlob).not.toContain(API_KEY);
    expect(ctaBlob.toLowerCase()).not.toContain("secret");
    expect(ctaBlob.toLowerCase()).not.toContain("token");
    expect([...new URL(cta.url).searchParams.keys()]).toEqual(["tab"]);
    expect(prompt).not.toContain(API_KEY);
  });

  it("explicit confirmation: the safe withdraw path fires exactly once", async () => {
    const withdrawals = trackWithdrawals();
    const runtime = keyedRuntime();
    const cb = captureCallback();
    await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("withdraw my Acme Bot earnings"),
      undefined,
      undefined,
      cb.fn,
    );
    const result = await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("confirmo"),
      undefined,
      { confirm: true },
      cb.fn,
    );

    expect(withdrawals.calls).toHaveLength(1);
    expect(withdrawals.calls[0]?.id).toBe("id-acme");
    expect(withdrawals.calls[0]?.request.amount).toBe(100);

    // Idempotency key present and within the server's 16–64 char bound.
    const key = withdrawals.calls[0]?.request.idempotency_key ?? "";
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(key.length).toBeLessThanOrEqual(64);

    expect(result?.success).toBe(true);
    expect((result?.data as { withdrawn: boolean }).withdrawn).toBe(true);

    // No secret transits the connector output on confirm either.
    const cta = (result?.data as { cta: ConnectorCta }).cta;
    expect(JSON.stringify(cta)).not.toContain(API_KEY);
    expect(cb.calls.at(-1)?.text).not.toContain(API_KEY);
  });

  it("honors the first-turn amount and ignores follow-up amount prose", async () => {
    const withdrawals = trackWithdrawals();
    const runtime = keyedRuntime();
    await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("withdraw $50 from Acme Bot"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    const result = await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("confirm, actually make it $500"),
      undefined,
      { confirm: true },
      captureCallback().fn,
    );
    expect(withdrawals.calls[0]?.request.amount).toBe(50);
    expect(result?.success).toBe(true);
  });

  it("structured confirm without a pending prompt does NOT withdraw", async () => {
    const withdrawals = trackWithdrawals();
    const result = await withdrawAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      captureCallback().fn,
    );
    expect(withdrawals.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe(
      "no_pending_confirmation",
    );
  });

  it("structured cancellation consumes the pending prompt without withdrawing", async () => {
    const withdrawals = trackWithdrawals();
    const runtime = keyedRuntime();
    await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("withdraw my Acme Bot earnings"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    const result = await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("cancel"),
      undefined,
      { confirm: false },
      captureCallback().fn,
    );
    expect(withdrawals.calls).toHaveLength(0);
    expect((result?.data as { canceled: boolean }).canceled).toBe(true);
  });

  it("refuses (no call) when the balance is below the payout threshold", async () => {
    setBalance(10, 25);
    const withdrawals = trackWithdrawals();
    const result = await withdrawAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("withdraw my Acme Bot earnings"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect(withdrawals.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe("below_threshold");
  });

  it("refuses (no call) when nothing is withdrawable", async () => {
    setBalance(0, 25);
    const withdrawals = trackWithdrawals();
    const result = await withdrawAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("withdraw Acme Bot"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect(withdrawals.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe("no_balance");
  });

  it("refuses (no call) when monetization is off", async () => {
    setGetAppEarnings(() =>
      Promise.resolve({
        success: true,
        earnings: {
          summary: { withdrawableBalance: 100, payoutThreshold: 25 },
        },
        monetization: { enabled: false },
      }),
    );
    const withdrawals = trackWithdrawals();
    const result = await withdrawAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("withdraw Acme Bot"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect(withdrawals.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe("not_monetized");
  });

  it("rejects an amount above the withdrawable balance (no call)", async () => {
    const withdrawals = trackWithdrawals();
    const result = await withdrawAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("withdraw $500 from Acme Bot"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect(withdrawals.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe("exceeds_balance");
  });

  it("returns not-found for an unknown app", async () => {
    const withdrawals = trackWithdrawals();
    const result = await withdrawAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("withdraw Zephyr"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect(withdrawals.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe("not_found");
  });

  it("degrades gracefully with no Cloud API key", async () => {
    const result = await withdrawAppEarningsAction.handler(
      unkeyedRuntime(),
      makeMessage("withdraw Acme Bot"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect((result?.data as { reason: string }).reason).toBe("no_key");
  });

  it("surfaces a withdraw API error on confirm", async () => {
    setWithdrawAppEarnings(() => Promise.reject(new Error("boom")));
    const runtime = keyedRuntime();
    await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("withdraw my Acme Bot earnings"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    const result = await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      captureCallback().fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("error");
  });
});
