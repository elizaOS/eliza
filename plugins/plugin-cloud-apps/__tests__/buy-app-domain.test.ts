/**
 * BUY_APP_DOMAIN tests — the money suite.
 *
 * Only the SDK boundary is faked; the two-phase confirm machine, quote TTL,
 * frozen-params execution, and every server-outcome mapping run for real.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type {
  BuyAppDomainInput,
  BuyAppDomainResponse,
} from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  makeRoomMessage,
  memoryRuntime,
  resetSdk,
  setBuyAppDomain,
  setCheckAppDomain,
  setListAppDomains,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));
const { buyAppDomainAction } = await import("../src/actions/buy-app-domain.ts");
const { CONFIRM_TTL_MS } = await import("../src/actions/buy-app-domain.ts");
const { persistCloudAppConfirmation } = await import("../src/safety.ts");

const APP = makeApp({ name: "Acme Bot", slug: "acme-bot" });
const OTHER = makeApp({
  id: "00000000-0000-0000-0000-000000000002",
  name: "Other App",
  slug: "other-app",
});

function trackBuys(
  result?:
    | Partial<BuyAppDomainResponse>
    | (() => Promise<BuyAppDomainResponse>),
) {
  const calls: Array<{ id: string; input: BuyAppDomainInput }> = [];
  setBuyAppDomain((id, input) => {
    calls.push({ id, input });
    if (typeof result === "function") return result();
    return Promise.resolve({
      success: true,
      domain: input.domain,
      appDomainId: "ad_1",
      zoneId: "zone_1",
      status: "pending",
      verified: false,
      expiresAt: "2027-07-01T00:00:00.000Z",
      pendingZoneProvisioning: false,
      debited: { totalUsdCents: 1399, currency: "USD" },
      ...(typeof result === "object" ? result : {}),
    });
  });
  return { calls };
}

function cloudError(status: number, error: string, code?: string): Error {
  return Object.assign(new Error(error), {
    statusCode: status,
    errorBody: { success: false, error, ...(code ? { code } : {}) },
  });
}

beforeEach(() => {
  resetSdk();
  setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
});

describe("BUY_APP_DOMAIN validate", () => {
  it("is true with a key, false without", async () => {
    expect(
      await buyAppDomainAction.validate?.(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await buyAppDomainAction.validate?.(unkeyedRuntime(), makeMessage("x")),
    ).toBe(false);
  });
});

describe("BUY_APP_DOMAIN first ask", () => {
  it("quotes the price + renewal, stages a confirmation, and NEVER buys", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    const { fn, calls: replies } = captureCallback();

    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      fn,
    );

    expect(calls.length).toBe(0);
    expect(result?.success).toBe(true);
    expect(result?.data?.confirmationRequired).toBe(true);
    expect(result?.data?.purchased).toBe(false);
    const text = replies[0]?.text ?? "";
    expect(text).toContain("example.com");
    expect(text).toContain('"Acme Bot"');
    expect(text).toContain("$13.99");
    expect(text).toContain("/yr");
  });

  it("hands back a CTA that is exactly {kind,label,url} with an https URL and no secrets", async () => {
    const runtime = keyedRuntime();
    trackBuys();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    const cta = result?.data?.cta as {
      kind: string;
      label: string;
      url: string;
    };
    expect(Object.keys(cta).sort()).toEqual(["kind", "label", "url"]);
    expect(cta.url.startsWith("https://")).toBe(true);
    expect(cta.url).not.toContain("eliza_test_key");
  });

  it("defaults to the sole app when the message names only the domain", async () => {
    const runtime = keyedRuntime();
    trackBuys();
    const { fn, calls: replies } = captureCallback();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com"),
      undefined,
      undefined,
      fn,
    );
    expect(result?.data?.confirmationRequired).toBe(true);
    expect(result?.data?.defaultedApp).toBe(true);
    expect(replies[0]?.text).toContain('"Acme Bot"');
  });

  it("asks which app when several apps exist and none matches", async () => {
    setListApps(() => Promise.resolve({ success: true, apps: [APP, OTHER] }));
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com"),
      undefined,
      undefined,
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("not_found");
    expect(result?.userFacingText).toContain("Acme Bot");
    expect(result?.userFacingText).toContain("Other App");
  });

  it("asks to disambiguate when the reference ties several apps", async () => {
    const twin = makeApp({
      id: "00000000-0000-0000-0000-000000000003",
      name: "Acme Bot",
      slug: "acme-bot-2",
    });
    setListApps(() => Promise.resolve({ success: true, apps: [APP, twin] }));
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.data?.reason).toBe("ambiguous");
  });

  it("refuses to guess between several domains in one message", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com or coolsite.io for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.data?.reason).toBe("multiple_domains");
  });

  it("asks for a domain when none is named", async () => {
    const runtime = keyedRuntime();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy a domain for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_domain");
  });

  it("reports an unavailable domain honestly and stages nothing", async () => {
    setCheckAppDomain((_id, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        available: false,
      }),
    );
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.data?.reason).toBe("unavailable");

    // No pending was staged: a follow-up confirm has nothing to act on.
    const confirmResult = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(confirmResult?.data?.reason).toBe("no_pending_confirmation");
    expect(calls.length).toBe(0);
  });

  it("says already-attached instead of 'taken' for the app's own domain", async () => {
    setCheckAppDomain((_id, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        available: false,
      }),
    );
    setListAppDomains(() =>
      Promise.resolve({
        success: true,
        domains: [
          {
            id: "ad_1",
            domain: "example.com",
            registrar: "cloudflare",
            status: "active",
            verified: true,
            sslStatus: "active",
            expiresAt: null,
            cloudflareZoneId: "zone_1",
            verificationToken: null,
          },
        ],
      }),
    );
    const runtime = keyedRuntime();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.data?.reason).toBe("already_attached");
    expect(result?.userFacingText).toContain("already attached");
  });

  it("refuses to stage a confirmation when the check returns no price", async () => {
    setCheckAppDomain((_id, input) =>
      Promise.resolve({ success: true, domain: input.domain, available: true }),
    );
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_price");
  });
});

describe("BUY_APP_DOMAIN confirm turn", () => {
  async function stagePurchase(runtime: ReturnType<typeof keyedRuntime>) {
    await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
  }

  it("buys exactly once with the FROZEN app + domain, ignoring follow-up prose", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    await stagePurchase(runtime);

    const { fn, calls: replies } = captureCallback();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("ok — actually make it othersite.net"),
      undefined,
      { confirm: true },
      fn,
    );

    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe(APP.id);
    expect(calls[0].input.domain).toBe("example.com");
    expect(result?.success).toBe(true);
    expect(result?.data?.purchased).toBe(true);
    expect(replies[0]?.text).toContain("charged $13.99");
  });

  it("reads confirm from nested options.parameters (real planner path)", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    await stagePurchase(runtime);
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirmo"),
      undefined,
      { parameters: { confirm: true } },
      undefined,
    );
    expect(calls.length).toBe(1);
    expect(result?.success).toBe(true);
  });

  it("cancels without buying on confirm:false and consumes the pending", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    await stagePurchase(runtime);

    const canceled = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("no, cancel"),
      undefined,
      { confirm: false },
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(canceled?.data?.canceled).toBe(true);

    const replay = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(replay?.data?.reason).toBe("no_pending_confirmation");
    expect(calls.length).toBe(0);
  });

  it("does nothing on confirm with no pending", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.data?.reason).toBe("no_pending_confirmation");
  });

  it("nudges (without buying) when a pending exists but no structured bool arrived", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    await stagePurchase(runtime);
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("hmm what do you think"),
      undefined,
      undefined,
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.data?.confirmationRequired).toBe(true);
  });

  it("refuses an expired quote instead of charging a stale price", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    await persistCloudAppConfirmation(runtime, {
      roomId: String(runtime.agentId),
      action: "BUY_APP_DOMAIN",
      appId: APP.id,
      appName: APP.name,
      amount: 13.99,
      domain: "example.com",
      intentCreatedAt: new Date(
        Date.now() - CONFIRM_TTL_MS - 1000,
      ).toISOString(),
    });
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("confirmation_expired");
  });

  it("re-quotes fresh when a stale pending is lying around and the user asks again", async () => {
    const runtime = keyedRuntime();
    trackBuys();
    await persistCloudAppConfirmation(runtime, {
      roomId: String(runtime.agentId),
      action: "BUY_APP_DOMAIN",
      appId: APP.id,
      appName: APP.name,
      amount: 13.99,
      domain: "stale.com",
      intentCreatedAt: new Date(
        Date.now() - CONFIRM_TTL_MS - 1000,
      ).toISOString(),
    });
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.data?.confirmationRequired).toBe(true);
    expect(result?.data?.domain).toBe("example.com");
  });
});

describe("BUY_APP_DOMAIN server outcomes", () => {
  async function stageAndConfirm(
    runtime: ReturnType<typeof keyedRuntime>,
  ): Promise<
    Awaited<ReturnType<NonNullable<typeof buyAppDomainAction.handler>>>
  > {
    await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    return (await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    )) as Awaited<ReturnType<NonNullable<typeof buyAppDomainAction.handler>>>;
  }

  it("402 → honest insufficient-credits message with a billing link, nothing purchased", async () => {
    const runtime = keyedRuntime();
    setBuyAppDomain(() =>
      Promise.reject(
        cloudError(
          402,
          "Insufficient credit balance for this domain",
          "insufficient_balance",
        ),
      ),
    );
    const result = await stageAndConfirm(runtime);
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("insufficient_credits");
    expect(result?.userFacingText).toContain("nothing was purchased");
    expect(result?.userFacingText).toContain("/dashboard/billing");
  });

  it("409 idempotency_retry → retries exactly once and succeeds", async () => {
    const runtime = keyedRuntime();
    let attempts = 0;
    setBuyAppDomain((_id, input) => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(
          cloudError(409, "Retry request", "idempotency_retry"),
        );
      }
      return Promise.resolve({
        success: true,
        domain: input.domain,
        appDomainId: "ad_1",
        zoneId: "zone_1",
        status: "pending",
        verified: false,
        expiresAt: null,
        pendingZoneProvisioning: false,
        debited: { totalUsdCents: 1399, currency: "USD" },
      });
    });
    const result = await stageAndConfirm(runtime);
    expect(attempts).toBe(2);
    expect(result?.success).toBe(true);
    expect(result?.data?.purchased).toBe(true);
  });

  it("409 idempotency_in_progress → reports in-progress, no double buy", async () => {
    const runtime = keyedRuntime();
    setBuyAppDomain(() =>
      Promise.reject(
        cloudError(
          409,
          "Domain purchase already in progress",
          "idempotency_in_progress",
        ),
      ),
    );
    const result = await stageAndConfirm(runtime);
    expect(result?.data?.reason).toBe("in_progress");
  });

  it("409 (taken) → relays the server message and says not charged", async () => {
    const runtime = keyedRuntime();
    setBuyAppDomain(() =>
      Promise.reject(
        cloudError(409, "Domain is not available for registration"),
      ),
    );
    const result = await stageAndConfirm(runtime);
    expect(result?.data?.reason).toBe("rejected");
    expect(result?.userFacingText).toContain("not charged");
  });

  it("502 (registrar failed) → says the charge was refunded", async () => {
    const runtime = keyedRuntime();
    setBuyAppDomain(() =>
      Promise.reject(cloudError(502, "registrar exploded")),
    );
    const result = await stageAndConfirm(runtime);
    expect(result?.data?.reason).toBe("registrar_failed");
    expect(result?.userFacingText).toContain("refunded");
  });

  it("502 persist_failed_recoverable → stages a no-charge recovery confirm that finishes the setup", async () => {
    const runtime = keyedRuntime();
    setBuyAppDomain(() =>
      Promise.reject(
        cloudError(
          502,
          "Domain was registered and charged, but final setup did not complete. Retry to finish assigning it to your app.",
          "persist_failed_recoverable",
        ),
      ),
    );
    const first = await stageAndConfirm(runtime);
    expect(first?.data?.reason).toBe("persist_failed_recoverable");
    expect(first?.data?.confirmationRequired).toBe(true);
    expect(first?.userFacingText).toContain("NOT be charged again");

    // The staged recovery confirm completes via the server's free recovery
    // branch — a registered-but-unattached orphan reads as unavailable to the
    // availability check, which is exactly what routes into the free recovery.
    setCheckAppDomain((_id, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        available: false,
      }),
    );
    const { calls } = trackBuys({
      alreadyRegistered: true,
      recoveredFromRegistrar: true,
      debited: undefined,
    });
    const second = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(calls.length).toBe(1);
    expect(calls[0].input.domain).toBe("example.com");
    expect(second?.success).toBe(true);
    expect(second?.data?.charged).toBe(false);
    expect(second?.userFacingText).toContain("without charging you again");
  });

  it("recovery confirm on a now-AVAILABLE domain re-quotes as a NEW purchase instead of silently buying", async () => {
    const runtime = keyedRuntime();
    setBuyAppDomain(() =>
      Promise.reject(
        cloudError(
          502,
          "Domain was registered and charged, but final setup did not complete.",
          "persist_failed_recoverable",
        ),
      ),
    );
    await stageAndConfirm(runtime); // leaves a recovery pending

    // Domain now reads as genuinely available — buying would debit a price
    // the user never confirmed, so the handler must re-quote, not buy.
    const { calls } = trackBuys();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.data?.confirmationRequired).toBe(true);
    expect(result?.data?.purchased).toBe(false);
    expect(result?.userFacingText).toContain("NEW purchase");
    expect(result?.userFacingText).toContain("$13.99");
  });

  it("recovery pendings never expire (no price at stake)", async () => {
    const runtime = keyedRuntime();
    await persistCloudAppConfirmation(runtime, {
      roomId: String(runtime.agentId),
      action: "BUY_APP_DOMAIN",
      appId: APP.id,
      appName: APP.name,
      domain: "example.com",
      recovery: true,
      intentCreatedAt: new Date(Date.now() - CONFIRM_TTL_MS * 10).toISOString(),
    });
    setCheckAppDomain((_id, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        available: false,
      }),
    );
    const { calls } = trackBuys({
      alreadyRegistered: true,
      recoveredFromRegistrar: true,
      debited: undefined,
    });
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(calls.length).toBe(1);
    expect(result?.success).toBe(true);
    expect(result?.userFacingText).toContain("without charging you again");
  });

  it("unknown error → honest uncertain outcome pointing at the domains tab", async () => {
    const runtime = keyedRuntime();
    setBuyAppDomain(() => Promise.reject(new Error("socket hang up")));
    const result = await stageAndConfirm(runtime);
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("error");
    expect(result?.userFacingText).toContain("may or may not");
  });

  it("mentions DNS provisioning when the zone is not ready yet", async () => {
    const runtime = keyedRuntime();
    trackBuys({ zoneId: null, pendingZoneProvisioning: true });
    const result = await stageAndConfirm(runtime);
    expect(result?.success).toBe(true);
    expect(result?.data?.pendingZoneProvisioning).toBe(true);
    expect(result?.userFacingText).toContain("DNS is still being set up");
  });
});

describe("BUY_APP_DOMAIN price enforcement", () => {
  it("re-quotes instead of buying when the price changed between quote and confirm", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );

    // Price jumps before the user confirms.
    setCheckAppDomain((_id, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        available: true,
        currency: "USD",
        years: 1,
        price: {
          wholesaleUsdCents: 1200,
          marginUsdCents: 399,
          totalUsdCents: 1599,
          marginBps: 3600,
        },
        renewal: { totalUsdCents: 1599 },
      }),
    );
    const requote = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(requote?.data?.confirmationRequired).toBe(true);
    expect(requote?.userFacingText).toContain("changed from $13.99 to $15.99");
    expect(requote?.userFacingText).toContain("didn't charge anything");

    // Confirming the NEW quote (price now stable at $15.99) buys exactly once.
    const confirmed = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(calls.length).toBe(1);
    expect(confirmed?.success).toBe(true);
  });

  it("refuses to buy when the confirm-time re-check fails, and says so honestly", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    setCheckAppDomain(() => Promise.reject(new Error("network down")));
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("precheck_failed");
    expect(result?.userFacingText).toContain("didn't buy anything");
  });

  it("reports honestly (not charged, no buy) when the domain got taken between quote and confirm", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    setCheckAppDomain((_id, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        available: false,
      }),
    );
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.data?.reason).toBe("unavailable");
    expect(result?.userFacingText).toContain("NOT charged");
  });

  it("stages the amount from a quote with distinct purchase/renewal prices and reports the real debit", async () => {
    const runtime = keyedRuntime();
    setCheckAppDomain((_id, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        available: true,
        currency: "USD",
        years: 1,
        price: {
          wholesaleUsdCents: 1911,
          marginUsdCents: 688,
          totalUsdCents: 2599,
          marginBps: 3600,
        },
        renewal: { totalUsdCents: 1899 },
      }),
    );
    const staged = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    expect(staged?.data?.amount).toBe(25.99);
    expect(staged?.data?.renewalUsdCents).toBe(1899);
    expect(staged?.userFacingText).toContain("charge $25.99");
    expect(staged?.userFacingText).toContain("auto-renews at $18.99/yr");

    const { calls } = trackBuys({
      debited: { totalUsdCents: 2599, currency: "USD" },
    });
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(calls.length).toBe(1);
    expect(result?.userFacingText).toContain("charged $25.99");
  });

  it("falls back to the confirmed amount when the server omits `debited`", async () => {
    const runtime = keyedRuntime();
    trackBuys({ debited: undefined });
    await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(result?.success).toBe(true);
    expect(result?.userFacingText).toContain("charged $13.99");
  });

  it('falls back to "the quoted price" when both debited and the confirmed amount are missing', async () => {
    const runtime = keyedRuntime();
    // A recovery pending carries no amount; a (contract-violating) bare
    // success without debited/alreadyRegistered flags exercises the last
    // defensive fallback.
    await persistCloudAppConfirmation(runtime, {
      roomId: String(runtime.agentId),
      action: "BUY_APP_DOMAIN",
      appId: APP.id,
      appName: APP.name,
      domain: "example.com",
      recovery: true,
    });
    setCheckAppDomain((_id, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        available: false,
      }),
    );
    setBuyAppDomain((_id, input) =>
      Promise.resolve({ success: true, domain: input.domain }),
    );
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(result?.success).toBe(true);
    expect(result?.userFacingText).toContain("the quoted price");
  });
});

describe("BUY_APP_DOMAIN recovery lifecycle (durable fact)", () => {
  it("cancel is honest about the standing charge and a later fresh ask still reaches the free recovery", async () => {
    const runtime = memoryRuntime();
    const message = makeRoomMessage("buy example.com for Acme Bot");

    // 1. Quote + confirm; the buy lands as charged+registered-but-unattached.
    await buyAppDomainAction.handler?.(
      runtime,
      message,
      undefined,
      undefined,
      undefined,
    );
    setBuyAppDomain(() =>
      Promise.reject(
        cloudError(
          502,
          "Domain was registered and charged, but final setup did not complete.",
          "persist_failed_recoverable",
        ),
      ),
    );
    const interrupted = await buyAppDomainAction.handler?.(
      runtime,
      makeRoomMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(interrupted?.data?.reason).toBe("persist_failed_recoverable");
    expect(runtime.__facts.length).toBe(1); // durable marker written

    // 2. Cancel the staged recovery — the reply must NOT claim "no domain was
    //    purchased" and the marker must survive.
    const canceled = await buyAppDomainAction.handler?.(
      runtime,
      makeRoomMessage("no, not now"),
      undefined,
      { confirm: false },
      undefined,
    );
    expect(canceled?.data?.reason).toBe("recovery_canceled");
    expect(canceled?.userFacingText).toContain("already charged");
    expect(canceled?.userFacingText).toContain("without a new charge");
    expect(canceled?.userFacingText).not.toContain("No domain was purchased");
    expect(runtime.__facts.length).toBe(1);

    // 3. A later fresh "buy X" reads unavailable — the marker routes it back
    //    to the free recovery instead of "isn't available to register".
    setCheckAppDomain((_id, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        available: false,
      }),
    );
    const reask = await buyAppDomainAction.handler?.(
      runtime,
      makeRoomMessage("buy example.com again please"),
      undefined,
      undefined,
      undefined,
    );
    expect(reask?.data?.reason).toBe("recovery_staged");
    expect(reask?.data?.confirmationRequired).toBe(true);
    expect(reask?.userFacingText).toContain("NOT be charged again");

    // 4. Confirming completes the free recovery and clears the marker.
    const { calls } = trackBuys({
      alreadyRegistered: true,
      recoveredFromRegistrar: true,
      debited: undefined,
    });
    const done = await buyAppDomainAction.handler?.(
      runtime,
      makeRoomMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(calls.length).toBe(1);
    expect(done?.success).toBe(true);
    expect(done?.userFacingText).toContain("without charging you again");
    expect(runtime.__facts.length).toBe(0);
  });
});

describe("BUY_APP_DOMAIN remaining exits", () => {
  it("degrades gracefully with no API key", async () => {
    const runtime = unkeyedRuntime();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_key");
  });

  it("returns an honest generic error when app resolution fails", async () => {
    setListApps(() => Promise.reject(new Error("boom")));
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com"),
      undefined,
      undefined,
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("error");
  });

  it("returns an honest generic error when the first-ask availability check fails", async () => {
    setCheckAppDomain(() => Promise.reject(new Error("boom")));
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.data?.reason).toBe("error");
    expect(result?.userFacingText).toContain("Nothing was purchased");
  });

  it("mentions the requested OTHER domain when nudging about an existing pending", async () => {
    const runtime = keyedRuntime();
    trackBuys();
    await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Acme Bot"),
      undefined,
      undefined,
      undefined,
    );
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("actually can you buy othersite.net instead"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.data?.confirmationRequired).toBe(true);
    expect(result?.data?.deferredDomain).toBe("othersite.net");
    expect(result?.userFacingText).toContain("othersite.net");
    expect(result?.userFacingText).toContain("example.com");
  });

  it("does NOT default to the sole app when an explicit appName matched nothing", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBuys();
    const result = await buyAppDomainAction.handler?.(
      runtime,
      makeMessage("buy example.com for Ghost App"),
      undefined,
      { appName: "Ghost App" },
      undefined,
    );
    expect(calls.length).toBe(0);
    expect(result?.data?.reason).toBe("not_found");
    expect(result?.userFacingText).toContain("Acme Bot");
  });
});
