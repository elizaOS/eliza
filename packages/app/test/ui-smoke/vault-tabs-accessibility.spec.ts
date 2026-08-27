/**
 * Verifies the Vault section switcher as a real keyboard-operated tab set
 * against the deterministic UI-smoke app and API stub.
 */

import { expect, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

test.describe("Vault tab accessibility", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/cloud/login", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          sessionId: "vault-tabs-login",
          browserUrl: "https://example.invalid/auth",
        }),
      });
    });
    await page.route("**/api/cloud/login/status**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "authenticated",
          token: "vault-tabs-test-token",
          organizationId: "vault-tabs-org",
          userId: "vault-tabs-user",
        }),
      });
    });
    await page.route("**/api/cloud/login/persist", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    });
    await seedAppStorage(page, {
      "app-workspace-chrome:chat-collapsed": "true",
    });
    await openAppPath(page, "/vault");
    await expect(page.getByTestId("section-nav-vault")).toBeVisible({
      timeout: 20_000,
    });
  });

  test("exposes tab semantics and supports roving keyboard focus", async ({
    page,
  }) => {
    const tabList = page.getByRole("tablist", { name: "Vault sections" });
    const overview = page.getByRole("tab", { name: "Overview" });
    const secrets = page.getByRole("tab", { name: "Secrets" });
    const logins = page.getByRole("tab", { name: "Logins" });
    const routing = page.getByRole("tab", { name: "Routing" });

    await expect(tabList).toBeVisible();
    await expect(overview).toHaveAttribute("aria-selected", "true");
    await expect(overview).toHaveAttribute("aria-controls", /.+/);
    await expect(secrets).toHaveAttribute("tabindex", "-1");

    await overview.focus();
    await page.keyboard.press("ArrowRight");
    await expect(secrets).toBeFocused();
    await expect(secrets).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("vault-tab-secrets-content")).toBeVisible();

    await page.keyboard.press("End");
    await expect(routing).toBeFocused();
    await expect(routing).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Home");
    await expect(overview).toBeFocused();
    await expect(overview).toHaveAttribute("aria-selected", "true");
    await expect(logins).toHaveAttribute("aria-selected", "false");
  });

  test("uses the desktop section-header layout at a desktop viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const refresh = page.getByRole("button", { name: "Re-detect backends" });
    await expect(refresh).toBeVisible();
    const headerDirection = await refresh.evaluate(
      (element) =>
        getComputedStyle(element.parentElement as HTMLElement).flexDirection,
    );
    expect(headerDirection).toBe("row");
  });
});
