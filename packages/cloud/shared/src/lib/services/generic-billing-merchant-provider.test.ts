/** Exercises Connect ownership, mode, onboarding and OAuth through actual SDK HTTP serialization. */
import { describe, expect, test } from "bun:test";
import Stripe from "stripe";
import { createGenericBillingMerchantProvider } from "./generic-billing-merchant-provider";

const owner = { merchantId: "merchant-one", ownerOrganizationId: "organization-one" };
const intent = {
  commandId: "merchant-command",
  idempotencyKey: "merchant-command:provider",
  requestDigest: "a".repeat(64),
};
function fixture() {
  const requests: { path: string; method: string; body: URLSearchParams; headers: Headers }[] = [];
  const state = {
    livemode: false,
    owner: "organization-one",
    accountType: "standard",
    adopted: true,
  };
  const stripe = new Stripe("sk_test_merchant_fixture", {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const body = new URLSearchParams(String(init?.body ?? ""));
      requests.push({ path, method, body, headers: new Headers(init?.headers) });
      let result: unknown;
      if (path === "/v1/balance") result = { object: "balance", livemode: state.livemode };
      else if (path === "/v1/accounts" || path === "/v1/accounts/acct_one") {
        if (method === "POST") state.adopted = true;
        result = {
          id: "acct_one",
          object: "account",
          type: state.accountType,
          metadata: state.adopted
            ? {
                eliza_merchant_id: owner.merchantId,
                eliza_merchant_owner_organization_id: state.owner,
              }
            : {},
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          capabilities: { card_payments: "active" },
          requirements: { disabled_reason: null, currently_due: [] },
        };
      } else if (path === "/v1/account_links")
        result = {
          object: "account_link",
          url: "https://connect.stripe.com/setup/fixture",
          expires_at: 1700000100,
        };
      else if (path === "/oauth/token")
        result = {
          stripe_user_id: "acct_one",
          livemode: state.livemode,
          scope: "read_write",
          access_token: "sensitive-local-token",
          refresh_token: "sensitive-local-refresh",
        };
      else if (path === "/oauth/deauthorize") result = { stripe_user_id: "acct_one" };
      else throw new Error(`Unexpected Connect fixture path ${path}`);
      return Response.json(result, { headers: { "request-id": "req_merchant_fixture" } });
    }),
  });
  return { provider: createGenericBillingMerchantProvider(stripe, false), requests, state };
}
describe("generic Connect merchant provider", () => {
  test("creates and links an organization-bound merchant with durable provider keys", async () => {
    const f = fixture();
    const result = await f.provider.create(
      owner,
      { country: "US", accountType: "standard" },
      intent,
    );
    expect(result.value.accountId).toBe("acct_one");
    const created = f.requests.find((request) => request.path === "/v1/accounts")!;
    expect(created.body.get("metadata[eliza_merchant_owner_organization_id]")).toBe(
      owner.ownerOrganizationId,
    );
    expect(created.headers.get("idempotency-key")).toBe(intent.idempotencyKey);
    expect(
      (
        await f.provider.createOnboardingLink(
          owner,
          {
            accountId: "acct_one",
            refreshUrl: "https://cloud.example.test/retry",
            returnUrl: "https://cloud.example.test/return",
          },
          intent,
        )
      ).url,
    ).toContain("connect.stripe.com");
  });
  test("wrong key mode or stored owner prevents merchant mutations", async () => {
    const f = fixture();
    f.state.livemode = true;
    await expect(
      f.provider.create(owner, { country: "US", accountType: "standard" }, intent),
    ).rejects.toThrow();
    expect(f.requests.some((request) => request.method === "POST")).toBe(false);
    const g = fixture();
    g.state.owner = "another-organization";
    await expect(
      g.provider.createOnboardingLink(
        owner,
        {
          accountId: "acct_one",
          refreshUrl: "https://cloud.example.test/retry",
          returnUrl: "https://cloud.example.test/return",
        },
        intent,
      ),
    ).rejects.toThrow();
    expect(g.requests.some((request) => request.method === "POST")).toBe(false);
  });
  test("OAuth adoption binds the authorized account and never returns provider tokens", async () => {
    const f = fixture();
    f.state.adopted = false;
    const result = await f.provider.adoptOAuth(owner, "local_code", intent);
    expect(result.value.accountId).toBe("acct_one");
    expect(JSON.stringify(result)).not.toContain("sensitive-local");
    expect(
      f.requests
        .find((request) => request.path === "/v1/accounts/acct_one" && request.method === "POST")
        ?.body.get("metadata[eliza_merchant_owner_organization_id]"),
    ).toBe(owner.ownerOrganizationId);
  });
  test("disconnection validates ownership and never deletes managed provider accounts", async () => {
    const f = fixture();
    expect(
      (
        await f.provider.disconnectStandardAccount(
          owner,
          { accountId: "acct_one", clientId: "ca_platform" },
          intent,
        )
      ).disconnected,
    ).toBe(true);
    const g = fixture();
    g.state.accountType = "express";
    await expect(
      g.provider.disconnectStandardAccount(
        owner,
        { accountId: "acct_one", clientId: "ca_platform" },
        intent,
      ),
    ).rejects.toThrow();
    expect(
      g.requests.some((request) => request.method === "POST" || request.method === "DELETE"),
    ).toBe(false);
  });
});
