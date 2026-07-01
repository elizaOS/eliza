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

    // The staged recovery confirm completes via the server's free recovery branch.
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
