import { expect, test } from "@playwright/test";

test.describe("brand flows", () => {
  test("landing renders headline and CTA on a solid background", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toBeVisible();
    // The landing hero is a static solid backdrop — no cloud video/poster.
    expect(await page.locator("video").count()).toBe(0);
    expect(await page.locator("img[src*='clouds']").count()).toBe(0);
    await expect(
      page.getByRole("button", { name: /launch eliza/i }).first(),
    ).toBeVisible();
  });

  test("Launch Eliza CTA navigates to /login", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: /launch eliza/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator("h1")).toContainText(/sign in/i);
  });

  test("checkout route redirects preorder UI to elizaOS", async ({ page }) => {
    await page.route("https://elizaos.ai/**", (route) =>
      route.fulfill({
        body: "<html><body>elizaOS checkout</body></html>",
        contentType: "text/html",
      }),
    );

    await page.goto("/checkout?collection=elizaos-hardware");
    await expect(page).toHaveURL(
      "https://elizaos.ai/checkout?collection=elizaos-hardware",
    );
    await expect(page.getByText("elizaOS checkout")).toBeVisible();
  });

  test("dashboard agents route renders without redirecting to login", async ({
    context,
    page,
  }) => {
    await context.addCookies([
      {
        name: "eliza-test-auth",
        value: "1",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);
    await page.route("**/api/**", (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [],
          agents: [],
          balance: 100,
          user: { id: "user_1", email: "test@example.com" },
        },
      }),
    );
    await page.goto("/dashboard/agents");
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("dashboard sub-pages render: settings, billing, api-keys", async ({
    context,
    page,
  }) => {
    await context.addCookies([
      {
        name: "eliza-test-auth",
        value: "1",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);
    await page.route("**/api/**", (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [],
          balance: 100,
          user: { id: "user_1", email: "test@example.com" },
        },
      }),
    );
    for (const path of [
      "/dashboard/settings",
      "/dashboard/billing",
      "/dashboard/api-keys",
    ]) {
      await page.goto(path);
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.locator("body")).toBeVisible();
    }
  });
});
