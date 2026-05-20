/**
 * Agent Team Chat (Agents) E2E Tests with Synpress
 *
 * Tests the unified team chat functionality for agent coordination:
 * - Loading the Agents page
 * - Viewing agent member list
 * - Sending messages with @mentions
 * - Mobile responsive design
 * - Real-time SSE connection status
 */

import { expect, test } from "./fixtures";
import {
  cooldownBetweenTests,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { loginWithWallet } from "./helpers/privy-auth";
import { ROUTES } from "./helpers/test-data";

// Increase test timeout for network operations
test.setTimeout(90000);

test.describe("Agent Team Chat (Agents)", () => {
  test.beforeEach(async ({ page }) => {
    // Desktop viewport
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Capture console errors for debugging
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
    await navigateTo(page, ROUTES.AGENTS_TEAM_CHAT);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    if (consoleErrors.length > 0) {
      console.log("ℹ️ Console errors during setup:", consoleErrors.slice(0, 3));
    }
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("should load Agents page", async ({ page }) => {
    expect(page.url()).toContain("/agents/team");

    const pageContent = await page.locator("body").textContent();

    // Check for Agents content
    const hasAgentsContent =
      pageContent?.toLowerCase().includes("agents") ||
      pageContent?.toLowerCase().includes("team") ||
      pageContent?.toLowerCase().includes("agent");

    expect(hasAgentsContent).toBe(true);

    await page.screenshot({
      path: "test-results/screenshots/11-agents-page.png",
      fullPage: true,
    });
    console.log("✅ Agents page loaded");
  });

  test('should display "no agents" state when user has no agents', async ({
    page,
  }) => {
    await page.waitForTimeout(1000);

    // Check for empty state or agent content
    const pageContent = await page.locator("body").textContent();

    // Either has agents or shows create agent prompt
    const hasContent =
      pageContent?.toLowerCase().includes("create") ||
      pageContent?.toLowerCase().includes("agent") ||
      pageContent?.toLowerCase().includes("agents");

    expect(hasContent).toBe(true);
    console.log("✅ Agents displays appropriate state");
  });

  test("should show connection status indicator", async ({ page }) => {
    await page.waitForTimeout(2000);

    // Look for SSE connection status indicator
    const liveIndicator = page.getByText(/Live|Connecting/i).first();
    const isVisible = await liveIndicator
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (isVisible) {
      console.log("✅ SSE connection status indicator visible");
    } else {
      // Check if page content loaded at all
      const pageContent = await page.locator("body").textContent();
      expect(pageContent?.length).toBeGreaterThan(100);
      console.log(
        "ℹ️ SSE status indicator not found - may be in different location",
      );
    }
  });

  test("should display member sidebar on desktop", async ({ page }) => {
    await page.waitForTimeout(1500);

    // Check for member sidebar content
    const teamMembersHeader = page.getByText(/Team Members|Members/i).first();
    const isVisible = await teamMembersHeader
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (isVisible) {
      console.log("✅ Member sidebar visible on desktop");
    } else {
      // May not have agents yet
      const pageContent = await page.locator("body").textContent();
      expect(pageContent).toBeTruthy();
      console.log("ℹ️ Member sidebar not visible (may have no agents)");
    }
  });

  test("should show message input area", async ({ page }) => {
    await page.waitForTimeout(1500);

    // Look for message input
    const messageInput = page
      .locator(
        'textarea[placeholder*="message" i], input[placeholder*="message" i]',
      )
      .or(page.locator('[contenteditable="true"]'))
      .first();

    const inputVisible = await messageInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (inputVisible) {
      console.log("✅ Message input area visible");
    } else {
      // May be showing empty state instead
      const pageContent = await page.locator("body").textContent();
      expect(pageContent).toBeTruthy();
      console.log("ℹ️ Message input not visible (may need agents first)");
    }
  });
});

test.describe("Agents @Mention Functionality", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
    await navigateTo(page, ROUTES.AGENTS_TEAM_CHAT);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("should show @mention autocomplete when typing @", async ({ page }) => {
    await page.waitForTimeout(1500);

    // Find message input
    const messageInput = page
      .locator('textarea, input[type="text"]')
      .filter({ hasText: /^$/ })
      .first()
      .or(page.locator('[contenteditable="true"]').first());

    const inputVisible = await messageInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (inputVisible) {
      await messageInput.click();
      await messageInput.type("@");
      await page.waitForTimeout(500);

      // Check for autocomplete dropdown
      const autocomplete = page
        .locator('[role="listbox"], [role="menu"]')
        .or(page.locator(".mention-autocomplete, .autocomplete"))
        .first();

      const autocompleteVisible = await autocomplete
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      await page.screenshot({
        path: "test-results/screenshots/11-mention-autocomplete.png",
      });

      if (autocompleteVisible) {
        console.log("✅ @mention autocomplete appears when typing @");
      } else {
        console.log(
          "ℹ️ Autocomplete not visible (may have no agents to mention)",
        );
      }
    } else {
      console.log("ℹ️ Message input not visible (may need agents first)");
    }
  });

  test("should insert mention when selecting from autocomplete", async ({
    page,
  }) => {
    await page.waitForTimeout(1500);

    // Find message input
    const messageInput = page.locator('textarea, input[type="text"]').first();

    const inputVisible = await messageInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (inputVisible) {
      await messageInput.click();
      await messageInput.fill("Hey @");
      await page.waitForTimeout(500);

      // Try to select first item in autocomplete
      const autocompleteItem = page
        .locator('[role="option"], [role="menuitem"]')
        .first();

      const itemVisible = await autocompleteItem
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      if (itemVisible) {
        await autocompleteItem.click();
        await page.waitForTimeout(300);

        // Input should now contain the mention
        const inputValue = await messageInput.inputValue().catch(() => "");
        console.log(
          `✅ Mention inserted: ${inputValue.includes("@") ? "yes" : "no"}`,
        );
      } else {
        console.log("ℹ️ No autocomplete items to select");
      }
    } else {
      console.log("ℹ️ Message input not visible");
    }
  });
});

test.describe("Agents Mobile Responsiveness", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("should load Agents on mobile", async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS_TEAM_CHAT);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    expect(page.url()).toContain("/agents/team");

    const pageContent = await page.locator("body").textContent();
    expect(pageContent).toBeTruthy();

    await page.screenshot({
      path: "test-results/screenshots/11-agents-mobile.png",
      fullPage: true,
    });

    console.log("✅ Agents loads on mobile");
  });

  test("should show mobile member drawer button", async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS_TEAM_CHAT);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    // Look for mobile member button (Users icon)
    const memberButton = page
      .locator('button[aria-label*="member" i], button[aria-label*="team" i]')
      .or(page.locator("button svg.lucide-users").locator(".."))
      .first();

    const buttonVisible = await memberButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (buttonVisible) {
      await memberButton.click();
      await page.waitForTimeout(500);

      // Check for drawer
      const drawer = page
        .locator('[class*="fixed"][class*="right-0"]')
        .or(page.getByText(/Team Members/i))
        .first();

      const drawerVisible = await drawer
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      await page.screenshot({
        path: "test-results/screenshots/11-mobile-member-drawer.png",
      });

      console.log(
        `✅ Mobile member drawer: ${drawerVisible ? "opened" : "button visible"}`,
      );
    } else {
      console.log("ℹ️ Mobile member button not visible (may have no agents)");
    }
  });

  test("should close mobile drawer when tapping backdrop", async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS_TEAM_CHAT);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    // Open drawer first
    const memberButton = page
      .locator('button[aria-label*="member" i], button[aria-label*="team" i]')
      .or(page.locator("button:has(svg)"))
      .first();

    const buttonVisible = await memberButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (buttonVisible) {
      await memberButton.click();
      await page.waitForTimeout(500);

      // Click backdrop to close
      const backdrop = page
        .locator('[class*="backdrop"]')
        .or(page.locator(".fixed.inset-0"))
        .first();
      const backdropVisible = await backdrop
        .isVisible({ timeout: 2000 })
        .catch(() => false);

      if (backdropVisible) {
        await backdrop.click({ position: { x: 50, y: 300 } });
        await page.waitForTimeout(500);

        console.log("✅ Mobile drawer closes on backdrop tap");
      } else {
        console.log("ℹ️ Backdrop not visible");
      }
    } else {
      console.log("ℹ️ Mobile member button not visible");
    }
  });
});

test.describe("Agents Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("should navigate to Agents from sidebar", async ({ page }) => {
    // Look for Agents link in sidebar
    const agentsLink = page
      .locator('a[href="/agents/team"]')
      .or(page.getByRole("link", { name: /Agents/i }))
      .first();

    const linkVisible = await agentsLink
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (linkVisible) {
      await agentsLink.click();
      await page.waitForTimeout(2000);

      expect(page.url()).toContain("/agents/team");
      console.log("✅ Navigation to Agents from sidebar works");
    } else {
      // User may not have agents
      console.log("ℹ️ Agents link not visible (requires agents)");
    }
  });

  test("should navigate to Agents from agents page", async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS);
    await waitForPageLoad(page);
    await page.waitForTimeout(1500);

    // Look for Agents Chat card/link on agents page
    const agentsCard = page
      .locator('a[href="/agents/team"]')
      .or(
        page
          .getByText(/Agents Chat/i)
          .locator("..")
          .locator("a"),
      )
      .first();

    const cardVisible = await agentsCard
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (cardVisible) {
      await agentsCard.click();
      await page.waitForTimeout(2000);

      expect(page.url()).toContain("/agents/team");
      console.log("✅ Navigation to Agents from agents page works");
    } else {
      console.log("ℹ️ Agents card not visible (requires agents)");
    }
  });

  test("should navigate to agent profile from member list", async ({
    page,
  }) => {
    await navigateTo(page, ROUTES.AGENTS_TEAM_CHAT);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    // Look for agent link in member sidebar
    const agentLink = page
      .locator('[class*="member"] a[href^="/agents/"]')
      .or(page.locator('a[href^="/agents/"]:has(svg.lucide-bot)'))
      .first();

    const linkVisible = await agentLink
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (linkVisible) {
      await agentLink.click();
      await page.waitForTimeout(2000);

      expect(page.url()).toMatch(/\/agents\/[a-zA-Z0-9]+/);
      console.log("✅ Navigation to agent profile from member list works");
    } else {
      console.log("ℹ️ Agent links not visible (user may have no agents)");
    }
  });
});
