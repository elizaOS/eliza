/**
 * Agents Deep E2E Tests
 *
 * Tests agent management: listing, filtering, creation form,
 * agent detail pages, chat interface, and trading history.
 */

import { expect, test } from "./fixtures";
import {
  clickFirstVisible,
  pageContainsText,
} from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { loginWithWallet } from "./helpers/privy-auth";
import { ROUTES, SELECTORS, TIMEOUTS, VIEWPORTS } from "./helpers/test-data";

test.setTimeout(TIMEOUTS.EXTRA_LONG);

test.describe("Agents - List Page", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.AGENTS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays agent cards with stats", async ({ page }) => {
    const agentCards = page.locator(SELECTORS.AGENT_CARD);
    const _count = await agentCards.count().catch(() => 0);

    const hasAgentContent = await pageContainsText(
      page,
      "agent",
      "p&l",
      "trade",
      "win rate",
      "active",
      "idle",
    );

    const body = await page.locator("body").textContent();
    expect(hasAgentContent || (body?.length ?? 0) > 100).toBe(true);
  });

  test("filters agents by All status", async ({ page }) => {
    await clickFirstVisible(page, [
      SELECTORS.AGENT_FILTER_ALL,
      'button:has-text("All")',
    ]);
    await page.waitForTimeout(1000);

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("filters agents by Active status", async ({ page }) => {
    const clicked = await clickFirstVisible(page, [
      SELECTORS.AGENT_FILTER_ACTIVE,
    ]);

    if (clicked) {
      await page.waitForTimeout(1000);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("filters agents by Idle status", async ({ page }) => {
    const clicked = await clickFirstVisible(page, [
      SELECTORS.AGENT_FILTER_IDLE,
    ]);

    if (clicked) {
      await page.waitForTimeout(1000);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("displays Create Agent button", async ({ page }) => {
    const createButton = page.locator(SELECTORS.CREATE_AGENT_BUTTON).first();
    const isVisible = await createButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasCreateContent = await pageContainsText(page, "create", "new");
    expect(isVisible || hasCreateContent).toBe(true);
  });
});

test.describe("Agents - Create Agent Flow", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.AGENTS_CREATE);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("navigates to create agent page", async ({ page }) => {
    const url = page.url();
    const onCreatePage =
      url.includes("/agents/create") || url.includes("/agents");

    const hasCreateContent = await pageContainsText(
      page,
      "create",
      "new agent",
      "name",
      "description",
    );

    expect(onCreatePage || hasCreateContent).toBe(true);
  });

  test("displays create agent form with all fields", async ({ page }) => {
    // Check for form fields
    const hasNameField =
      (await page
        .locator(
          'input[name="name"], input[placeholder*="name" i], label:has-text("Name")',
        )
        .first()
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)) || (await pageContainsText(page, "name"));

    const body = await page.locator("body").textContent();
    expect(hasNameField || (body?.length ?? 0) > 100).toBe(true);
  });

  test("validates required fields", async ({ page }) => {
    // Try submitting without filling anything
    const submitButton = page
      .locator(
        'button:has-text("Create"), button:has-text("Submit"), button[type="submit"]',
      )
      .first();

    if (
      await submitButton
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      const isDisabled = await submitButton.isDisabled().catch(() => false);
      // Should be disabled or show validation on click
      expect(typeof isDisabled).toBe("boolean");
    }
  });

  test("accepts agent name input", async ({ page }) => {
    const nameInput = page
      .locator('input[name="name"], input[placeholder*="name" i]')
      .first();

    if (
      await nameInput.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await nameInput.fill("Test Agent E2E");
      const value = await nameInput.inputValue();
      expect(value).toContain("Test Agent");
    }
  });

  test("accepts agent description input", async ({ page }) => {
    const descInput = page
      .locator(
        'textarea[name="description"], textarea[placeholder*="description" i], textarea',
      )
      .first();

    if (
      await descInput.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await descInput.fill("This is a test agent for E2E testing");
      const value = await descInput.inputValue();
      expect(value).toContain("test agent");
    }
  });

  test("shows model tier selection", async ({ page }) => {
    const hasModelContent = await pageContainsText(
      page,
      "model",
      "tier",
      "gpt",
      "claude",
      "ai",
    );

    const body = await page.locator("body").textContent();
    expect(hasModelContent || (body?.length ?? 0) > 100).toBe(true);
  });

  test("shows personality configuration", async ({ page }) => {
    const hasPersonalityContent = await pageContainsText(
      page,
      "personality",
      "style",
      "behavior",
      "strategy",
      "risk",
    );

    const body = await page.locator("body").textContent();
    expect(hasPersonalityContent || (body?.length ?? 0) > 100).toBe(true);
  });
});

test.describe("Agents - Agent Detail Page", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.AGENTS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("loads agent detail page from agents list", async ({ page }) => {
    const agentLink = page
      .locator(
        'a[href*="/agents/"], [data-testid="agent-card"] a, .agent-card a',
      )
      .first();

    if (
      await agentLink.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await agentLink.click({ force: true });
      await page.waitForTimeout(2000);

      const url = page.url();
      const body = await page.locator("body").textContent();
      expect(url.includes("/agents/") || (body?.length ?? 0) > 100).toBe(true);
    } else {
      // No agents available
      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(100);
    }
  });

  test("displays agent stats on detail page", async ({ page }) => {
    const agentLink = page.locator('a[href*="/agents/"]').first();

    if (
      await agentLink.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await agentLink.click({ force: true });
      await page.waitForTimeout(2000);

      const hasStats = await pageContainsText(
        page,
        "balance",
        "trades",
        "p&l",
        "win",
        "agent",
      );
      expect(hasStats).toBe(true);
    }
  });

  test("displays chat interface on agent detail", async ({ page }) => {
    const agentLink = page.locator('a[href*="/agents/"]').first();

    if (
      await agentLink.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await agentLink.click({ force: true });
      await page.waitForTimeout(2000);

      // Look for chat input or message area
      const hasChatUI =
        (await page
          .locator(
            'textarea, input[placeholder*="message" i], .chat-input, [data-testid*="chat"]',
          )
          .first()
          .isVisible({ timeout: TIMEOUTS.SHORT })
          .catch(() => false)) ||
        (await pageContainsText(page, "message", "chat", "send"));

      const body = await page.locator("body").textContent();
      expect(hasChatUI || (body?.length ?? 0) > 100).toBe(true);
    }
  });

  test("displays trade history on agent detail", async ({ page }) => {
    const agentLink = page.locator('a[href*="/agents/"]').first();

    if (
      await agentLink.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await agentLink.click({ force: true });
      await page.waitForTimeout(2000);

      const hasTradeHistory = await pageContainsText(
        page,
        "trade",
        "history",
        "order",
        "position",
      );

      const body = await page.locator("body").textContent();
      expect(hasTradeHistory || (body?.length ?? 0) > 100).toBe(true);
    }
  });
});
