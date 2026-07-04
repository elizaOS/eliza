/**
 * WITHDRAW_APP_EARNINGS action tests: the money-out two-phase confirm and the frozen-snapshot guard. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
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

const { parseWithdrawAmount, withdrawAppEarningsAction } = await import(
  "../src/actions/withdraw-app-earnings.ts"
);
const { CONFIRM_TTL_MS, persistCloudAppConfirmation } = await import(
  "../src/safety.ts"
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

  it("refuses a STALE (expired) confirm instead of moving money — TTL parity with buy-domain/book-influencer", async () => {
    const withdrawals = trackWithdrawals();
    const runtime = keyedRuntime();
    // A pending already older than the confirm TTL: a bare "yes" must NOT fire a
    // money-out withdrawal on a stale confirmation.
    await persistCloudAppConfirmation(runtime, {
      roomId: String(runtime.agentId),
      action: "WITHDRAW_APP_EARNINGS",
      appId: APP.id,
      appName: APP.name,
      amount: 100,
      intentCreatedAt: new Date(
        Date.now() - CONFIRM_TTL_MS - 1000,
      ).toISOString(),
    });
    const result = await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("confirmo"),
      undefined,
      { confirm: true },
      captureCallback().fn,
    );
    expect(withdrawals.calls).toHaveLength(0);
    expect(result?.success).toBe(false);
    expect((result?.data as { reason?: string }).reason).toBe(
      "confirmation_expired",
    );
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

  it("MONEY: confirm naming a DIFFERENT app refuses, moves nothing, clears the pending", async () => {
    const withdrawals = trackWithdrawals();
    const runtime = keyedRuntime();
    const cb = captureCallback();
    await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("withdraw $50 from Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    const result = await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("yes — withdraw from Beta Dashboard"),
      undefined,
      { parameters: { confirm: true, appName: "Beta Dashboard" } },
      cb.fn,
    );

    expect(withdrawals.calls).toHaveLength(0);
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe(
      "confirm_target_mismatch",
    );
    const reply = cb.calls.at(-1)?.text ?? "";
    expect(reply).toContain("Beta Dashboard");
    expect(reply).toContain("Acme Bot");

    // Pending cleared: a later bare confirm cannot fund the stale withdrawal.
    const followUp = await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      cb.fn,
    );
    expect(withdrawals.calls).toHaveLength(0);
    expect((followUp?.data as { reason: string }).reason).toBe(
      "no_pending_confirmation",
    );
  });

  it("MONEY: confirm carrying a DIFFERENT structured amount refuses (frozen $50 vs turn $500)", async () => {
    const withdrawals = trackWithdrawals();
    const runtime = keyedRuntime();
    const cb = captureCallback();
    await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("withdraw $50 from Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    const result = await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("confirm, make it $500"),
      undefined,
      { parameters: { confirm: true, amount: 500 } },
      cb.fn,
    );
    expect(withdrawals.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe(
      "confirm_target_mismatch",
    );

    // A matching structured amount on the confirm turn still withdraws.
    await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("withdraw $50 from Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    const ok = await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("confirm the $50 withdrawal"),
      undefined,
      { parameters: { confirm: true, appName: "Acme Bot", amount: 50 } },
      cb.fn,
    );
    expect(ok?.success).toBe(true);
    expect(withdrawals.calls).toHaveLength(1);
    expect(withdrawals.calls[0]?.request.amount).toBe(50);
  });

  it("MONEY REGRESSION: planner-nested amount stages $50, NOT the full balance", async () => {
    // Real planner path (execute-planned-tool-call.ts): validated args arrive
    // under options.parameters and the text carries no digits. Losing that
    // nested amount would stage the full withdrawable balance.
    const withdrawals = trackWithdrawals();
    const runtime = keyedRuntime();
    const cb = captureCallback();
    const first = await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("withdraw fifty dollars from my Acme Bot earnings"),
      undefined,
      { parameters: { appName: "Acme Bot", amount: 50 } },
      cb.fn,
    );
    expect((first?.data as { amount: number }).amount).toBe(50);
    expect(cb.calls[0]?.text).toContain("$50.00");
    expect(cb.calls[0]?.text).not.toContain("$100.00");
    expect(withdrawals.calls).toHaveLength(0);

    const result = await withdrawAppEarningsAction.handler(
      runtime,
      makeMessage("confirmo"),
      undefined,
      { parameters: { confirm: true } },
      captureCallback().fn,
    );
    expect(result?.success).toBe(true);
    expect(withdrawals.calls).toHaveLength(1);
    expect(withdrawals.calls[0]?.request.amount).toBe(50); // NOT the full 100
  });

  it("REGRESSION: a digit inside the app name never reads as an amount", async () => {
    // App-name digits are not standalone money amounts; "Acme2" must resolve as
    // an app reference and stage the full balance unless the user names an amount.
    const acme2 = makeApp({
      id: "id-acme2",
      name: "Acme2",
      slug: "acme2",
      monetization_enabled: true,
    });
    setListApps(() => Promise.resolve({ success: true, apps: [acme2] }));
    const withdrawals = trackWithdrawals();
    const cb = captureCallback();
    const result = await withdrawAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("withdraw my Acme2 earnings"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(true);
    expect((result?.data as { amount: number }).amount).toBe(100);
    expect(cb.calls[0]?.text).toContain("$100.00");
    expect(withdrawals.calls).toHaveLength(0);
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

describe("parseWithdrawAmount — planner options (nested `parameters` first) + text", () => {
  it("MONEY REGRESSION: reads the amount nested under options.parameters — the real planner shape", () => {
    // Missing this returned null → the handler staged the FULL withdrawable
    // balance for a "withdraw fifty dollars from Acme" ask.
    expect(
      parseWithdrawAmount("withdraw fifty dollars from Acme", {
        parameters: { amount: 50 },
      }),
    ).toBe(50);
    expect(
      parseWithdrawAmount("", { parameters: { amount: "$1,250.50" } }),
    ).toBe(1250.5);
    expect(parseWithdrawAmount("", { parameters: { usd: 25 } })).toBe(25);
  });

  it("nested planner args win over top-level keys", () => {
    expect(
      parseWithdrawAmount("", { amount: 10, parameters: { amount: 50 } }),
    ).toBe(50);
  });

  it("still reads top-level options (direct handler calls)", () => {
    expect(parseWithdrawAmount("", { amount: 50 })).toBe(50);
    expect(parseWithdrawAmount("", { value: "75" })).toBe(75);
  });

  it("ignores non-positive / non-numeric option values", () => {
    expect(parseWithdrawAmount("", { parameters: { amount: 0 } })).toBeNull();
    expect(parseWithdrawAmount("", { parameters: { amount: -5 } })).toBeNull();
    expect(
      parseWithdrawAmount("", { parameters: { amount: "fifty" } }),
    ).toBeNull();
  });

  it("parses explicit currency and standalone amounts from text", () => {
    expect(parseWithdrawAmount("withdraw $50 from Acme")).toBe(50);
    expect(parseWithdrawAmount("withdraw 50 dollars from Acme")).toBe(50);
    expect(parseWithdrawAmount("cash out 12.5 usd")).toBe(12.5);
    expect(parseWithdrawAmount("withdraw 50 from Acme")).toBe(50);
    expect(parseWithdrawAmount("payout 25")).toBe(25);
  });

  it("REGRESSION: a digit glued into an app name is NOT an amount", () => {
    // Only standalone numeric tokens count as requested payout amounts.
    expect(parseWithdrawAmount("withdraw my Acme2 earnings")).toBeNull();
    expect(parseWithdrawAmount("cash out App2000")).toBeNull();
    expect(parseWithdrawAmount("payout for my a1b2 app")).toBeNull();
  });

  it("rejects a number glued to trailing letters (not a standalone token)", () => {
    expect(parseWithdrawAmount("withdraw 50k from Acme")).toBeNull();
  });

  it("returns null (= full balance) when no amount appears anywhere", () => {
    expect(parseWithdrawAmount("withdraw my Acme earnings")).toBeNull();
    expect(parseWithdrawAmount("withdraw fifty dollars")).toBeNull();
    expect(parseWithdrawAmount("")).toBeNull();
    expect(parseWithdrawAmount("", undefined)).toBeNull();
  });
});
