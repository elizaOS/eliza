// Live Steward-authenticated hardware checkout smoke.
//
// This is intentionally opt-in because it creates a fresh Steward wallet user
// and asks the live Cloud API to create a Stripe checkout session. The test
// stops at the hosted Stripe checkout page; it never enters payment details.
//
// Enable with:
//   LIVE_OS_HOMEPAGE_STEWARD_CHECKOUT=1 \
//   bun run --cwd packages/os-homepage test:e2e live-steward-checkout.spec.ts --project desktop

import { StewardAuth } from "@stwd/sdk";
import { expect, type Page, type Route, test } from "playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const LIVE_STEWARD_CHECKOUT_ENABLED =
  process.env.LIVE_OS_HOMEPAGE_STEWARD_CHECKOUT === "1";
const CLOUD_API_URL = (
  process.env.VITE_ELIZA_CLOUD_API_URL || "https://api.elizacloud.ai"
).replace(/\/+$/, "");
const STEWARD_API_URL = (
  process.env.LIVE_STEWARD_API_URL || "https://eliza.steward.fi"
).replace(/\/+$/, "");
const STEWARD_TENANT_ID = "elizacloud";
const OS_PRODUCTION_ORIGIN = "https://elizaos.ai";

test.setTimeout(120_000);

async function signInWithFreshStewardWallet() {
  const account = privateKeyToAccount(generatePrivateKey());
  const auth = new StewardAuth({
    baseUrl: STEWARD_API_URL,
    tenantId: STEWARD_TENANT_ID,
  });
  const result = await auth.signInWithSIWE(account.address, (message) =>
    account.signMessage({ message }),
  );
  expect(result.token).toBeTruthy();
  expect(result.refreshToken).toBeTruthy();
  return {
    token: result.token,
    refreshToken: result.refreshToken,
  };
}

async function forwardLiveCloudRequest(route: Route) {
  const request = route.request();
  const response = await fetch(request.url(), {
    method: request.method(),
    headers: {
      ...request.headers(),
      Origin: OS_PRODUCTION_ORIGIN,
      Referer: `${OS_PRODUCTION_ORIGIN}/checkout`,
    },
    body:
      request.method() === "GET" || request.method() === "HEAD"
        ? undefined
        : request.postData(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  await route.fulfill({
    status: response.status,
    body,
    headers: {
      "content-type":
        response.headers.get("content-type") ?? "application/json",
    },
  });
}

async function installLiveCloudForwarders(page: Page) {
  const observed = {
    sessionSync: false,
    checkoutSession: null as {
      body: unknown;
      status: number;
      url?: string;
    } | null,
  };

  await page.route(
    `${CLOUD_API_URL}/api/auth/steward-session`,
    async (route) => {
      observed.sessionSync = true;
      await forwardLiveCloudRequest(route);
    },
  );

  await page.route(
    `${CLOUD_API_URL}/api/stripe/create-checkout-session`,
    async (route) => {
      const request = route.request();
      const response = await fetch(request.url(), {
        method: request.method(),
        headers: {
          ...request.headers(),
          Origin: OS_PRODUCTION_ORIGIN,
          Referer: `${OS_PRODUCTION_ORIGIN}/checkout`,
        },
        body: request.postData(),
        signal: AbortSignal.timeout(30_000),
      });
      const bodyText = await response.text();
      const body = bodyText ? (JSON.parse(bodyText) as { url?: string }) : {};
      observed.checkoutSession = {
        body: request.postDataJSON(),
        status: response.status,
        url: body.url,
      };
      await route.fulfill({
        status: response.status,
        json: body,
      });
    },
  );

  await page.route("https://checkout.stripe.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Stripe Checkout</title><main><h1>Stripe Checkout</h1></main>",
    });
  });

  return observed;
}

test.describe("live Steward checkout", () => {
  test.skip(
    !LIVE_STEWARD_CHECKOUT_ENABLED,
    "set LIVE_OS_HOMEPAGE_STEWARD_CHECKOUT=1 to hit live Steward and Cloud checkout",
  );

  test("SIWE Steward token unlocks checkout and starts a live Stripe checkout session", async ({
    page,
  }) => {
    const { token, refreshToken } = await signInWithFreshStewardWallet();
    const observed = await installLiveCloudForwarders(page);

    await page.goto(
      `/checkout?sku=elizaos-phone#token=${encodeURIComponent(
        token,
      )}&refreshToken=${encodeURIComponent(refreshToken)}`,
      { waitUntil: "domcontentloaded" },
    );

    await expect(
      page.getByRole("heading", { name: "ElizaOS Phone" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Pay deposit" })).toBeVisible(
      { timeout: 30_000 },
    );
    expect(observed.sessionSync).toBe(true);

    await page.getByRole("button", { name: "Select Blue glass" }).click();
    await page.getByRole("button", { name: "Pay deposit" }).click();

    await expect
      .poll(() => observed.checkoutSession, { timeout: 30_000 })
      .toMatchObject({
        status: 200,
        body: {
          hardwareSku: "elizaos-phone",
          hardwareColor: "Blue glass",
          returnUrl: "billing",
        },
      });
    expect(observed.checkoutSession?.url).toMatch(
      /^https:\/\/checkout\.stripe\.com\//,
    );
    await expect(
      page.getByRole("heading", { name: "Stripe Checkout" }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
