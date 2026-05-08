import { expect, type Page, test } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  smokeTestPage,
  strictSmokeTestPage,
} from "../fixtures/page-helpers";

// @eliza-live-audit allow-route-fixtures
// Public page smoke tests isolate route rendering from invite and public agent data setup.

async function mockValidInvite(page: Page): Promise<void> {
  await page.route("**/api/invites/validate**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          organization_name: "Playwright Test Org",
          invited_email: "invitee@example.com",
          role: "member",
          expires_at: "2099-01-01T00:00:00.000Z",
          inviter_name: "Test Admin",
        },
      }),
    });
  });
}

async function mockPublicCharacter(page: Page): Promise<void> {
  const character = {
    id: "00000000-0000-4000-8000-000000000000",
    name: "Playwright Agent",
    username: "playwright-agent",
    avatarUrl: null,
    bio: "A public agent used by route smoke tests.",
    creatorUsername: "playwright",
  };

  await page.route("**/api/characters/*/public", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: character,
      }),
    });
  });

  await page.route("**/api/auth/anonymous-session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        isNew: true,
        user: { id: "anon-playwright" },
        session: {
          id: "session-playwright",
          message_count: 0,
          messages_limit: 3,
          session_token: "anon-session-token",
          expires_at: "2099-01-01T00:00:00.000Z",
          is_active: true,
        },
      }),
    });
  });
}

async function expectDocumentPath(page: Page, path: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname).toBe(path);
}

const RESPONSIVE_VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const RESPONSIVE_PUBLIC_ROUTES = [
  "/",
  "/login",
  "/blog",
  "/docs/api",
  "/invite/accept?token=playwright-valid-token",
] as const;

test.describe("Public Pages", () => {
  test.describe("Responsive Layout", () => {
    for (const viewport of RESPONSIVE_VIEWPORTS) {
      for (const path of RESPONSIVE_PUBLIC_ROUTES) {
        test(`${path} has no horizontal overflow at ${viewport.name} width`, async ({ page }) => {
          if (path.startsWith("/invite/accept")) {
            await mockValidInvite(page);
          }

          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await smokeTestPage(page, path);
          await expectNoHorizontalOverflow(page, `${path} ${viewport.name}`);
        });
      }
    }
  });

  test.describe("Landing & Marketing", () => {
    test("/ renders the landing page", async ({ page }) => {
      await smokeTestPage(page, "/");

      await expect(
        page.getByText("Eliza Cloud is everything you need", { exact: false }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Get Started Free" })).toBeVisible();
    });

    test("/ redirects Stripe session callbacks with React Router", async ({ page }) => {
      await smokeTestPage(page, "/?session_id=cs_test_123&from=settings");

      await expect.poll(() => new URL(page.url()).pathname).toBe("/dashboard/billing/success");
      const redirectedUrl = new URL(page.url());
      expect(redirectedUrl.searchParams.get("session_id")).toBe("cs_test_123");
      expect(redirectedUrl.searchParams.get("from")).toBe("settings");
    });

    test("/login renders the Steward login page", async ({ page }) => {
      await smokeTestPage(page, "/login");

      await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
      await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
    });

    test("/login has no critical JS errors", async ({ page }) => {
      await strictSmokeTestPage(page, "/login");
    });

    test("/login Terms link reaches the React Router terms route", async ({ page }) => {
      await smokeTestPage(page, "/login");

      await page.getByRole("link", { name: "Terms" }).click();
      await expectDocumentPath(page, "/terms-of-service");
      await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();
    });

    test("/terms-of-service renders legal content and login navigation", async ({ page }) => {
      await smokeTestPage(page, "/terms-of-service");

      await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();
      await expect(page.getByText("Acceptance of Terms")).toBeVisible();
      await expect(page.getByRole("link", { name: "Return to login" })).toHaveAttribute(
        "href",
        "/login",
      );
    });

    test("/privacy-policy renders legal content and terms navigation", async ({ page }) => {
      await smokeTestPage(page, "/privacy-policy");

      await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();
      await expect(page.getByText("Information We Collect")).toBeVisible();
      await expect(page.getByRole("link", { name: "Terms of Service" })).toHaveAttribute(
        "href",
        "/terms-of-service",
      );
    });
  });

  test.describe("Public Chat", () => {
    test("/chat/:id renders a shared agent route", async ({ page }) => {
      await mockPublicCharacter(page);

      await smokeTestPage(page, "/chat/00000000-0000-4000-8000-000000000000");

      await expect(page.getByRole("heading", { name: "Meet Playwright Agent." })).toBeVisible();
    });

    test("/chat/@username renders a shared username route", async ({ page }) => {
      await mockPublicCharacter(page);

      await smokeTestPage(page, "/chat/@playwright-agent");

      await expectDocumentPath(page, "/chat/@playwright-agent");
      await expect(page.getByRole("heading", { name: "Meet Playwright Agent." })).toBeVisible();
    });
  });

  test.describe("Blog", () => {
    test("/blog renders the blog index route", async ({ page }) => {
      await smokeTestPage(page, "/blog");

      await expect(page.getByRole("heading", { name: "Cloud Blog" })).toBeVisible();
    });

    test("/blog/:slug renders an existing post", async ({ page }) => {
      await smokeTestPage(page, "/blog/introducing-eliza-cloud");

      await expect(
        page.getByRole("heading", {
          name: "Chat AI Agents Faster. Ship Them Instantly. Introducing Eliza Cloud.",
        }),
      ).toBeVisible();
      await expect(page.locator("body")).not.toContainText("Post not found");
    });

    test("/blog/:slug handles missing posts inside the SPA", async ({ page }) => {
      await smokeTestPage(page, "/blog/nonexistent-post");

      await expect(page.getByRole("heading", { name: "Post not found" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Back to the blog index" })).toHaveAttribute(
        "href",
        "/blog",
      );
    });
  });

  test.describe("Documentation", () => {
    test("/docs renders the docs index route", async ({ page }) => {
      await smokeTestPage(page, "/docs");

      await expect(
        page.getByText("The complete platform for building, deploying", { exact: false }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Quickstart Guide" })).toBeVisible();
    });

    test("/docs/* renders nested MDX routes and sidebar navigation", async ({ page }) => {
      await smokeTestPage(page, "/docs/api");

      await expect(page.getByRole("heading", { name: "REST API Reference" })).toBeVisible();

      await page.getByRole("link", { name: "Quickstart Guide" }).click();
      await expectDocumentPath(page, "/docs/quickstart");
      await expect(page.getByRole("heading", { name: "Quickstart" })).toBeVisible();
    });

    test("/docs/* renders the docs not-found state for unknown slugs", async ({ page }) => {
      await smokeTestPage(page, "/docs/does-not-exist");

      await expect(page.getByRole("heading", { name: "Page Not Found" })).toBeVisible();
      await expect(page.locator("code")).toContainText("/docs/does-not-exist");
    });
  });

  test.describe("Auth Pages", () => {
    test("/auth/success renders a generic success state", async ({ page }) => {
      await smokeTestPage(page, "/auth/success");

      await expect(page.getByRole("heading", { name: "Connection Successful" })).toBeVisible();
      await expect(page.getByText("Return to your chat and say")).toBeVisible();
    });

    test("/auth/success derives the connected platform from query params", async ({ page }) => {
      await smokeTestPage(page, "/auth/success?platform=github");

      await expect(page.getByRole("heading", { name: "GitHub Connected" })).toBeVisible();
    });

    test("/auth/error renders reason-specific error copy", async ({ page }) => {
      await smokeTestPage(page, "/auth/error?reason=sync_failed");

      await expect(page.getByRole("heading", { name: "Authentication Sync Failed" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Try Again" })).toBeVisible();
    });

    test("/auth/cli-login renders a missing-session error without crashing", async ({ page }) => {
      await smokeTestPage(page, "/auth/cli-login");

      await expect(page.getByRole("heading", { name: "Authentication Error" })).toBeVisible();
      await expect(page.getByText("Missing session ID")).toBeVisible();
    });

    test("/auth/cli-login preserves its query string when routing to login", async ({ page }) => {
      await smokeTestPage(page, "/auth/cli-login?session=cli_test_123&foo=bar");

      await expect(page.getByRole("heading", { name: "CLI Authentication" })).toBeVisible();
      await page.getByRole("link", { name: "Sign In" }).click();

      await expectDocumentPath(page, "/login");
      const returnTo = new URL(page.url()).searchParams.get("returnTo");
      expect(returnTo).toBe("/auth/cli-login?session=cli_test_123&foo=bar");
    });
  });

  test.describe("OAuth & App Auth", () => {
    test("/app-auth/authorize renders the missing-parameter error", async ({ page }) => {
      await smokeTestPage(page, "/app-auth/authorize");

      await expect(page.getByRole("heading", { name: "Authorization Error" })).toBeVisible();
      await expect(page.getByText("Missing app_id parameter")).toBeVisible();
    });
  });

  test.describe("Payment & Invite", () => {
    test("/payment/success renders the callback and preserves unauthenticated returnTo", async ({
      page,
    }) => {
      await smokeTestPage(page, "/payment/success?trackId=track_test_123&status=paid");

      await expect(page.locator("body")).toContainText(/Payment Received|Welcome back/);

      const currentUrl = new URL(page.url());
      if (currentUrl.pathname === "/login") {
        expect(currentUrl.searchParams.get("returnTo")).toBe(
          "/dashboard/settings?tab=billing&payment=success&trackId=track_test_123&status=paid",
        );
      }
    });

    test("/invite/accept renders invite details from the validation loader", async ({ page }) => {
      await mockValidInvite(page);

      await smokeTestPage(page, "/invite/accept?token=test-token");

      await expect(page.getByText("You're Invited!")).toBeVisible();
      await expect(page.getByText("Playwright Test Org")).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign In to Accept" })).toBeVisible();
    });

    test("/invite/accept routes unauthenticated acceptance through login returnTo", async ({
      page,
    }) => {
      await mockValidInvite(page);
      await smokeTestPage(page, "/invite/accept?token=test-token");

      await page.getByRole("button", { name: "Sign In to Accept" }).click();

      await expectDocumentPath(page, "/login");
      expect(new URL(page.url()).searchParams.get("returnTo")).toBe(
        "/invite/accept?token=test-token",
      );
    });
  });

  test.describe("Sandbox Proxy", () => {
    test("/sandbox-proxy renders the environment-specific proxy state", async ({ page }) => {
      await smokeTestPage(page, "/sandbox-proxy");

      await expect(page.locator("body")).toContainText(
        /Eliza Sandbox Proxy Active|Sandbox proxy is only available in development mode/,
      );
    });
  });
});
