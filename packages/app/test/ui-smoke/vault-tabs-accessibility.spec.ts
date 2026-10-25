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

  test("uses the full available page width on every Vault tab", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    for (const tab of ["Overview", "Secrets", "Logins", "Routing"]) {
      await page.getByRole("tab", { name: tab }).click();
      const panel = page.getByRole("tabpanel", {
        name: `${tab} Vault section`,
      });
      await expect(panel).toBeVisible();
      const panelBox = await panel.boundingBox();
      const contentBox = await panel
        .locator(":scope > *")
        .first()
        .boundingBox();

      expect(contentBox?.x).toBe(panelBox?.x);
      expect(contentBox?.width).toBe(panelBox?.width);
    }
  });

  test("shares route gutters with the Character family", async ({ page }) => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 820, height: 1180 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await openAppPath(page, "/vault");
      await expect(page.getByTestId("section-nav-vault")).toBeVisible();
      const vaultBody = await page
        .locator("[data-framed-page-body]")
        .boundingBox();
      const vaultTab = await page
        .getByTestId("vault-tab-overview")
        .boundingBox();

      for (const characterRoute of [
        "/character",
        "/character/skills",
        "/character/experience",
      ]) {
        await openAppPath(page, characterRoute);
        await expect(page.getByTestId("section-nav-character")).toBeVisible();
        const characterBody = await page
          .locator("[data-framed-page-body]")
          .boundingBox();
        const characterTab = await page
          .getByRole("button", { name: "Personality" })
          .boundingBox();

        expect(characterBody?.x).toBe(vaultBody?.x);
        expect(characterBody?.width).toBe(vaultBody?.width);
        expect(characterTab?.x).toBe(vaultTab?.x);
      }

      await openAppPath(page, "/character/select");
      await expect(page.locator("[data-framed-page-body]")).toBeVisible();
      const characterSelectBody = await page
        .locator("[data-framed-page-body]")
        .boundingBox();
      expect(characterSelectBody?.x).toBe(vaultBody?.x);
      expect(characterSelectBody?.width).toBe(vaultBody?.width);
    }
  });
});
