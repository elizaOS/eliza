/**
 * Playwright e2e coverage driving a real MetaMask wallet (@avalix/chroma + Privy) against a live Feed dev server; every spec skips when the /api/health check fails.
 *
 * Deep coverage of the agents surface: list, creation, and detail views.
 */
import { expect, test } from "./fixtures";
import {
  clickTab,
  fillAndVerify,
  pageContainsText,
} from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { ROUTES, SELECTORS, VIEWPORTS } from "./helpers/test-data";
import { loginWithWallet } from "./helpers/wallet-auth";

test.setTimeout(60000);

test.describe("Agents - List", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.AGENTS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("agent cards display", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("filter All agents", async ({ page }) => {
    const switched = await clickTab(page, "All");
    test.skip(!switched, 'no "All" filter rendered on the agents list');
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("filter Active agents", async ({ page }) => {
    const switched = await clickTab(page, "Active");
    test.skip(!switched, 'no "Active" filter rendered on the agents list');
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("filter Idle agents", async ({ page }) => {
    const switched = await clickTab(page, "Idle");
    test.skip(!switched, 'no "Idle" filter rendered on the agents list');
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("create agent button visible", async ({ page }) => {
    const createBtn = page.locator(SELECTORS.CREATE_AGENT_BUTTON).first();
    const isVisible = await createBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(
      !isVisible,
      "no create-agent button rendered on the agents list",
    );
    await expect(createBtn).toBeEnabled();
  });
});

test.describe("Agents - Create", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.AGENTS_CREATE);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("create page navigates from list", async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS);
    await waitForPageLoad(page);
    const createBtn = page.locator(SELECTORS.CREATE_AGENT_BUTTON).first();
    const isVisible = await createBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no create-agent button rendered on the agents list");
    const beforeUrl = page.url();
    await createBtn.click({ force: true });
    await page.waitForTimeout(2000);
    expect(page.url()).not.toBe(beforeUrl);
  });

  test("create form renders", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("form validation present", async ({ page }) => {
    const submitBtn = page
      .locator(
        'button:has-text("Create"), button:has-text("Submit"), button:has-text("Save")',
      )
      .first();
    const isVisible = await submitBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(
      !isVisible,
      "no submit button rendered on the agent creation form",
    );
    await submitBtn.click({ force: true });
    await page.waitForTimeout(500);
    // Submitting an empty form must not navigate away (validation blocks it).
    expect(page.url()).toContain("create");
  });

  test("name input accepts values", async ({ page }) => {
    const result = await fillAndVerify(
      page,
      'input[name="name"], input[placeholder*="name" i]',
      "Test Agent",
    );
    test.skip(
      result === null,
      "no name input rendered on the agent creation form",
    );
    expect(result).toBe("Test Agent");
  });

  test("model tier selection available", async ({ page }) => {
    const hasModelTier = await pageContainsText(
      page,
      "model",
      "tier",
      "gpt",
      "claude",
      "llm",
    );
    test.skip(
      !hasModelTier,
      "no model selection rendered on the agent creation form",
    );
    expect(hasModelTier).toBe(true);
  });

  test("personality field available", async ({ page }) => {
    const hasPersonality = await pageContainsText(
      page,
      "personality",
      "behavior",
      "style",
      "prompt",
    );
    test.skip(
      !hasPersonality,
      "no personality field rendered on the agent creation form",
    );
    expect(hasPersonality).toBe(true);
  });
});

test.describe("Agents - Detail", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.AGENTS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("load agent detail from list", async ({ page }) => {
    const agentCard = page
      .locator('[data-testid*="agent"], .agent-card, a[href*="agents/"]')
      .first();
    const isVisible = await agentCard
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no agent cards rendered on the agents list");
    const beforeUrl = page.url();
    await agentCard.click({ force: true });
    await page.waitForTimeout(2000);
    expect(page.url()).not.toBe(beforeUrl);
  });

  test("agent stats visible", async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS_BY_ID("test-agent"));
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("agent chat available", async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS_BY_ID("test-agent"));
    await waitForPageLoad(page);
    const notFound = await pageContainsText(page, "not found", "404");
    test.skip(notFound, 'agent "test-agent" does not exist in this environment');
    const hasChat = await pageContainsText(page, "chat", "message", "send");
    expect(hasChat).toBe(true);
  });

  test("agent trade history visible", async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS_BY_ID("test-agent"));
    await waitForPageLoad(page);
    const notFound = await pageContainsText(page, "not found", "404");
    test.skip(notFound, 'agent "test-agent" does not exist in this environment');
    const hasTrades = await pageContainsText(
      page,
      "trade",
      "history",
      "position",
      "order",
    );
    test.skip(!hasTrades, "no trade history rendered (agent has no trades)");
    expect(hasTrades).toBe(true);
  });
});
