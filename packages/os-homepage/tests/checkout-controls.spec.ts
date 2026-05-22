import { expect, type Page, test } from "playwright/test";

async function installCheckoutMocks(page: Page) {
  const requests: Array<{
    url: string;
    body: unknown;
    headers: Record<string, string>;
  }> = [];

  await page.route("https://api.elizacloud.ai/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    requests.push({ url: request.url(), body, headers: request.headers() });

    if (url.pathname === "/api/auth/steward-session") {
      return route.fulfill({
        json: { success: true, user: { id: "steward-user-1" } },
      });
    }

    if (url.pathname === "/api/auth/steward-nonce-exchange") {
      return route.fulfill({
        json: {
          ok: true,
          userId: "cloud-user-1",
          stewardUserId: "steward-user-1",
          token: "steward-token-from-code",
        },
      });
    }

    if (url.pathname === "/api/stripe/create-checkout-session") {
      return route.fulfill({
        json: {
          url: "http://127.0.0.1:4455/checkout/success?sku=elizaos-phone",
        },
      });
    }

    return route.fulfill({
      json: { success: true },
    });
  });

  return requests;
}

test("checkout product picker, color swatches, and email login are wired", async ({
  page,
}) => {
  await installCheckoutMocks(page);

  await page.goto("/checkout?sku=elizaos-usb");
  await expect(
    page.getByRole("heading", { name: "ElizaOS USB" }),
  ).toBeVisible();

  await page.getByRole("button", { name: /ElizaOS Phone/i }).click();
  await expect(page).toHaveURL(/\/checkout\?sku=elizaos-phone$/);
  await expect(
    page.getByRole("heading", { name: "ElizaOS Phone" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Select Blue glass" }).click();

  await page.getByRole("button", { name: "Email link" }).click();
  await expect(page.getByText("Enter your email first.")).toBeVisible();

  await page
    .getByPlaceholder("you@example.com")
    .fill("checkout-controls@example.com");
  await page.getByRole("button", { name: "Email link" }).click();
  await expect(page.getByText("Check your inbox.")).toBeVisible();
});

test("checkout accepts a Steward token and posts the selected product to Stripe", async ({
  page,
}) => {
  const requests = await installCheckoutMocks(page);

  await page.goto(
    "/checkout?sku=elizaos-phone#token=steward-token-1&refreshToken=refresh-token-1",
  );
  await expect(page.getByRole("button", { name: "Pay deposit" })).toBeVisible();
  await page.getByRole("button", { name: "Select Blue glass" }).click();
  await page.getByRole("button", { name: "Pay deposit" }).click();
  await expect(page).toHaveURL(/\/checkout\/success\?sku=elizaos-phone$/);

  const sessionRequest = requests.find(
    (request) => new URL(request.url).pathname === "/api/auth/steward-session",
  );
  expect(sessionRequest?.body).toMatchObject({
    token: "steward-token-1",
    refreshToken: "refresh-token-1",
  });

  const checkoutRequest = requests.find(
    (request) =>
      new URL(request.url).pathname === "/api/stripe/create-checkout-session",
  );
  expect(checkoutRequest?.headers.authorization).toBe(
    "Bearer steward-token-1",
  );
  expect(checkoutRequest?.body).toMatchObject({
    hardwareSku: "elizaos-phone",
    hardwareColor: "Blue glass",
    returnUrl: "billing",
  });
});

test("checkout exchanges a query code and uses the returned bearer for Stripe", async ({
  page,
}) => {
  const requests = await installCheckoutMocks(page);

  await page.goto("/checkout?code=oauth-code-1&sku=elizaos-phone");
  await expect(page.getByRole("button", { name: "Pay deposit" })).toBeVisible();
  await expect(page).toHaveURL(/\/checkout\?sku=elizaos-phone$/);

  const exchangeRequest = requests.find(
    (request) =>
      new URL(request.url).pathname === "/api/auth/steward-nonce-exchange",
  );
  expect(exchangeRequest?.body).toMatchObject({
    code: "oauth-code-1",
    redirectUri: "http://127.0.0.1:4455/checkout?sku=elizaos-phone",
    tenantId: "elizacloud",
  });

  await page.getByRole("button", { name: "Pay deposit" }).click();
  await expect(page).toHaveURL(/\/checkout\/success\?sku=elizaos-phone$/);

  const checkoutRequest = requests.find(
    (request) =>
      new URL(request.url).pathname === "/api/stripe/create-checkout-session",
  );
  expect(checkoutRequest?.headers.authorization).toBe(
    "Bearer steward-token-from-code",
  );
});

test("checkout accepts OAuth-style hash token names and strips the fragment", async ({
  page,
}) => {
  const requests = await installCheckoutMocks(page);

  await page.goto(
    "/checkout?sku=elizaos-phone#access_token=steward-token-2&refresh_token=refresh-token-2",
  );
  await expect(page.getByRole("button", { name: "Pay deposit" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe("");

  const sessionRequest = requests.find(
    (request) => new URL(request.url).pathname === "/api/auth/steward-session",
  );
  expect(sessionRequest?.body).toMatchObject({
    token: "steward-token-2",
    refreshToken: "refresh-token-2",
  });
});
