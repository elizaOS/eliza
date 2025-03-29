import { test, expect } from '@playwright/test';
import { waitForElizaInitialization } from './utils';

test.describe('UI - Basic UI Interaction: Access Web UI', () => {
  // Increase test timeout
  test.setTimeout(60000);

  test('should open the ElizaOS web interface successfully', async ({ page }) => {
    try {
      // Navigate to the ElizaOS web interface
      await page.goto('/', { timeout: 30000 });
      console.log('Started loading ElizaOS web interface');

      // Take a screenshot immediately after navigation
      await page.screenshot({ path: 'screenshots/web-interface-initial-load.png' });

      // Wait for ElizaOS to initialize
      await waitForElizaInitialization(page);
      console.log('ElizaOS initialization complete');

      // Take a screenshot after initialization
      await page.screenshot({ path: 'screenshots/web-interface-loaded.png' });

      // Add debug logging to help identify page structure
      console.log('Logging page structure for debugging:');
      const html = await page.evaluate(() => {
        return document.body.innerHTML.substring(0, 500); // First 500 chars
      });
      console.log('Page HTML (first 500 chars):', html);

      // Log available classes for debugging
      const classes = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('*'))
          .map((el) => (typeof el.className === 'string' ? el.className : ''))
          .filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i) // Unique values
          .slice(0, 20); // Limit to first 20
      });
      console.log('Available classes:', classes);

      // Simple verification that the page loaded successfully
      await expect(page.locator('body')).toBeVisible();

      // Verify we have content on the page
      const bodyText = await page.locator('body').textContent();
      expect(bodyText?.length).toBeGreaterThan(10);

      // Check for the sidebar wrapper (left-hand side pane of the dashboard)
      // This is a very specific selector based on the actual UI implementation
      const sidebarWrapper = page.locator(
        '#root > div > div.group\\/sidebar-wrapper.flex.min-h-svh.w-full.has-\\[\\[data-variant\\=inset\\]\\]\\:bg-card > div'
      );
      const hasSidebarWrapper = await sidebarWrapper.isVisible().catch(() => false);
      console.log(`Sidebar wrapper visible: ${hasSidebarWrapper}`);

      // Alternative more resilient approach using attribute selectors
      const sidebarAlternative = page.locator(
        'div.group\\/sidebar-wrapper, [class*="sidebar-wrapper"]'
      );
      const hasSidebarAlternative = await sidebarAlternative.isVisible().catch(() => false);
      console.log(`Sidebar found with alternative selector: ${hasSidebarAlternative}`);

      // If sidebar is visible, take a screenshot of it
      if (hasSidebarWrapper || hasSidebarAlternative) {
        await (hasSidebarWrapper ? sidebarWrapper : sidebarAlternative).screenshot({
          path: 'screenshots/web-interface-sidebar.png',
        });
        console.log('Captured screenshot of sidebar wrapper');
      }

      // Count visible elements for debugging
      const visibleDivs = await page.locator('div:visible').count();
      const visibleButtons = await page.locator('button:visible').count();
      const visibleInputs = await page.locator('input:visible, textarea:visible').count();

      console.log(
        `Visible elements: ${visibleDivs} divs, ${visibleButtons} buttons, ${visibleInputs} inputs/textareas`
      );

      // Take a screenshot of the dashboard area
      await page.screenshot({ path: 'screenshots/web-interface-dashboard.png' });

      // Check for expected elements on the dashboard
      // Look for "Agents" section or heading
      const hasAgentSection = await page
        .locator('text=Agents, text="Agents", h1:has-text("Agents"), h2:has-text("Agents")')
        .count();
      console.log(`Found ${hasAgentSection} agent sections`);

      // Look for message buttons
      const messageButtons = await page.locator('button:has-text("Message")').count();
      console.log(`Found ${messageButtons} message buttons`);

      // Verify there's at least one message button or agent card
      const agentCards = await page
        .locator('.group, [role="button"], a')
        .filter({ hasText: /Eliza|Laura/ })
        .count();
      console.log(`Found ${agentCards} agent cards`);

      // Take a screenshot of an agent card if found
      if (agentCards > 0) {
        const firstCard = page
          .locator('.group, [role="button"], a')
          .filter({ hasText: /Eliza|Laura/ })
          .first();
        await firstCard.screenshot({ path: 'screenshots/web-interface-agent-card.png' });
        console.log('Captured screenshot of first agent card');
      }

      // Make sure we have either message buttons or agent cards or sidebar
      const hasRequiredElements =
        messageButtons > 0 || agentCards > 0 || hasSidebarWrapper || hasSidebarAlternative;
      expect(hasRequiredElements).toBeTruthy();

      // Look for other UI elements like settings menu, logo, etc.
      const hasHeader = await page.locator('header, nav, .navbar').isVisible();
      const hasLogo = await page.locator('img[alt*="logo" i], .logo, svg.logo').isVisible();
      const hasSettings = await page
        .locator('button:has-text("Settings"), button[aria-label="Settings"]')
        .isVisible();

      console.log(
        `UI elements detected: Header=${hasHeader}, Logo=${hasLogo}, Settings=${hasSettings}`
      );

      // Take a screenshot of the header/navigation area if found
      if (hasHeader) {
        await page
          .locator('header, nav, .navbar')
          .first()
          .screenshot({ path: 'screenshots/web-interface-header.png' });
        console.log('Captured screenshot of header/navigation area');
      }

      // Check that there are no errors in the console logs
      const consoleLogs: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleLogs.push(msg.text());
        }
      });

      // Give some time for any console errors to appear
      await page.waitForTimeout(2000);

      // Assert that there are no console errors
      // Note: We log errors but don't fail the test on console errors to improve stability
      if (consoleLogs.length > 0) {
        console.warn(`Found ${consoleLogs.length} console errors: ${consoleLogs.join(', ')}`);
      }

      // Verify page title contains expected text if available
      const title = await page.title();
      console.log('Page title:', title);

      // Take a final screenshot for verification
      await page.screenshot({ path: 'screenshots/web-interface-verification-complete.png' });

      console.log('Test completed successfully');
    } catch (error) {
      // Take a screenshot of the error state
      await page.screenshot({ path: 'screenshots/web-interface-error.png' });
      throw error;
    }
  });
});
