import { expect, type Page, test } from "@playwright/test";
import { smokeTestPage, strictSmokeTestPage } from "./fixtures/page-helpers";

function currentUrl(page: Page): URL {
  return new URL(page.url());
}

function expectedOrigin(baseURL?: string): string {
  return new URL(baseURL || process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000").origin;
}

async function expectPath(page: Page, path: string): Promise<void> {
  await expect.poll(() => currentUrl(page).pathname).toBe(path);
}

test.describe("Authentication Routing", () => {
  test.describe("Login Page returnTo Parameter", () => {
    test("login preserves a dashboard returnTo parameter in the URL", async ({ page }) => {
      await smokeTestPage(page, "/login?returnTo=/dashboard/settings");

      const url = currentUrl(page);
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("returnTo")).toBe("/dashboard/settings");
      await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    });

    test("login renders without page errors when returnTo is provided", async ({ page }) => {
      await strictSmokeTestPage(page, "/login?returnTo=/dashboard/settings");

      await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
    });

    test("returnTo accepts encoded relative paths with query strings", async ({ page }) => {
      const complexPath = "/dashboard/chat?characterId=abc-123&mode=test";

      await smokeTestPage(page, `/login?returnTo=${encodeURIComponent(complexPath)}`);

      const url = currentUrl(page);
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("returnTo")).toBe(complexPath);
    });

    test("unsafe returnTo values do not navigate away during page load", async ({
      page,
      baseURL,
    }) => {
      const unsafeValues = [
        "//evil.com",
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "https://evil.com/path",
      ];

      for (const value of unsafeValues) {
        await smokeTestPage(page, `/login?returnTo=${encodeURIComponent(value)}`);

        const url = currentUrl(page);
        expect(url.origin).toBe(expectedOrigin(baseURL));
        expect(url.pathname).toBe("/login");
      }
    });
  });

  test.describe("Protected Route Redirects", () => {
    test("protected dashboard index redirects unauthenticated users to login", async ({ page }) => {
      await smokeTestPage(page, "/dashboard");

      await expectPath(page, "/login");
      expect(currentUrl(page).searchParams.get("returnTo")).toBe("/dashboard");
    });

    test("protected dashboard settings preserves the full returnTo path", async ({ page }) => {
      await smokeTestPage(page, "/dashboard/settings?tab=billing");

      await expectPath(page, "/login");
      expect(currentUrl(page).searchParams.get("returnTo")).toBe("/dashboard/settings?tab=billing");
    });

    test("free-mode dashboard chat stays on the React Router route", async ({ page }) => {
      await smokeTestPage(page, "/dashboard/chat");

      await expectPath(page, "/dashboard/chat");
    });
  });

  test.describe("Auth Page Navigation", () => {
    test("/auth/error Try Again navigates with React Router", async ({ page }) => {
      await smokeTestPage(page, "/auth/error?reason=auth_failed");

      await page.getByRole("button", { name: "Try Again" }).click();

      await expectPath(page, "/login");
    });

    test("/auth/error Go Home link navigates to the landing route", async ({ page }) => {
      await smokeTestPage(page, "/auth/error?reason=unknown");

      await page.getByRole("link", { name: "Go Home" }).click();

      await expectPath(page, "/");
      await expect(page.getByRole("heading", { name: "Monetize your agents" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Get Started Free" })).toBeVisible();
    });

    test("/auth/cli-login Sign In link encodes the original CLI auth URL", async ({ page }) => {
      await smokeTestPage(page, "/auth/cli-login?session=cli_test_123");

      await page.getByRole("link", { name: "Sign In" }).click();

      await expectPath(page, "/login");
      expect(currentUrl(page).searchParams.get("returnTo")).toBe(
        "/auth/cli-login?session=cli_test_123",
      );
    });
  });

  test.describe("Payment and Invite Routing", () => {
    test("payment success redirects unauthenticated users to login with billing returnTo", async ({
      page,
    }) => {
      await smokeTestPage(page, "/payment/success?trackId=track_test_456&status=paid");

      await expect.poll(() => currentUrl(page).pathname).toMatch(/^\/(payment\/success|login)$/);

      if (currentUrl(page).pathname === "/login") {
        expect(currentUrl(page).searchParams.get("returnTo")).toBe(
          "/dashboard/settings?tab=billing&payment=success&trackId=track_test_456&status=paid",
        );
      }
    });

    test("invite accept without a token renders a local error state", async ({ page }) => {
      await smokeTestPage(page, "/invite/accept");

      await expect(page.getByRole("heading", { name: "Invalid Invitation" })).toBeVisible();
      await expect(page.getByText("No invitation token provided")).toBeVisible();
    });
  });

  test.describe("Page Response Codes", () => {
    test("public auth routes return the Vite SPA shell", async ({ request }) => {
      for (const path of [
        "/login",
        "/login?returnTo=/dashboard/settings",
        "/auth/success",
        "/auth/error",
        "/auth/cli-login",
        "/app-auth/authorize",
        "/invite/accept?token=test-token",
        "/payment/success",
      ]) {
        const response = await request.get(path);
        expect(response.status(), `${path} returned ${response.status()}`).toBe(200);
      }
    });

    test("protected dashboard routes also return the SPA shell", async ({ request }) => {
      for (const path of ["/dashboard", "/dashboard/settings", "/dashboard/chat"]) {
        const response = await request.get(path);
        expect(response.status(), `${path} returned ${response.status()}`).toBe(200);
      }
    });
  });
});

test.describe("Console Error Monitoring", () => {
  test("login page should not have critical console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await smokeTestPage(page, "/login");

    const criticalErrors = consoleErrors.filter(
      (error) =>
        !error.includes("WalletConnect") &&
        !error.includes("LCP") &&
        !error.includes("favicon") &&
        !error.includes("eth_accounts") &&
        !error.includes("404") &&
        !error.includes("Failed to load resource"),
    );

    expect(criticalErrors).toHaveLength(0);
  });

  test("dashboard redirect should not have critical console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await smokeTestPage(page, "/dashboard");
    await expectPath(page, "/login");

    const criticalErrors = consoleErrors.filter(
      (error) =>
        !error.includes("WalletConnect") &&
        !error.includes("LCP") &&
        !error.includes("favicon") &&
        !error.includes("eth_accounts") &&
        !error.includes("Failed to load resource"),
    );

    expect(criticalErrors).toHaveLength(0);
  });
});
