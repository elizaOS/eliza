import { expect, type Page, test } from "playwright/test";

async function installCheckoutMocks(page: Page) {
  const requests: Array<{ url: string; body: unknown }> = [];

  await page.route("https://api.elizacloud.ai/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    requests.push({ url: request.url(), body });

    if (url.pathname === "/api/auth/steward-session") {
      return route.fulfill({
        json: { success: true, user: { id: "steward-user-1" } },
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

test("checkout product picker, color swatches, email login, and Stripe handoff are wired", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const requests = await installCheckoutMocks(page);

  await page.goto("/checkout?sku=elizaos-usb");
  await expect(page.getByRole("heading", { name: "ElizaOS USB" })).toBeVisible();

  await page.getByRole("button", { name: /ElizaOS Phone/i }).click();
  await expect(page).toHaveURL(/\/checkout\?sku=elizaos-phone$/);
  await expect(page.getByRole("heading", { name: "ElizaOS Phone" })).toBeVisible();

  await page.getByRole("button", { name: "Select Blue glass" }).click();

  await page.getByRole("button", { name: "Email link" }).click();
  await expect(page.getByText("Enter your email first.")).toBeVisible();

  await page
    .getByPlaceholder("you@example.com")
    .fill("checkout-controls@example.com");
  await page.getByRole("button", { name: "Email link" }).click();
  await expect(page.getByText("Check your inbox.")).toBeVisible();

  await page.goto(
    "/checkout?sku=elizaos-phone#token=steward-token-1&refreshToken=refresh-token-1",
  );
  await expect(page.getByRole("button", { name: "Pay deposit" })).toBeVisible();
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
  expect(checkoutRequest?.body).toMatchObject({
    hardwareSku: "elizaos-phone",
    hardwareColor: "Blue glass",
    returnUrl: "billing",
  });
});
