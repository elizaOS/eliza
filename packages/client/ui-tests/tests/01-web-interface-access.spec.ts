import { test, expect } from '@playwright/test';
import { logger } from './logger';

test.describe('UI - Basic UI Interaction: Access Web UI', () => {
  // Increase test timeout
  test.setTimeout(60000);

  test('should open the ElizaOS web interface successfully', async ({ page }) => {
    // Collect console errors for assertion
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    try {
      // Navigate to the ElizaOS web interface
      await page.goto('/', { timeout: 30000 });
      logger.info('Navigated to the ElizaOS web interface');

      // Wait for page to load completely using general selectors
      await page.waitForSelector('#root, .app, [role="main"], main', { timeout: 30000 });
      logger.info('Main application container loaded');

      // Verify essential UI elements are present
      await expect(page.locator('body')).toBeVisible();

      // Check for page title
      const title = await page.title();
      logger.info(`Page title: ${title}`);
      expect(title.length).toBeGreaterThan(0);

      // Check for main content areas using general selectors
      const mainContentSelectors = [
        'main',
        '[role="main"]',
        '.main-content',
        '.container',
        '.app',
      ].join(', ');

      const mainContentCount = await page.locator(mainContentSelectors).count();
      expect(mainContentCount).toBeGreaterThan(0);
      logger.info(`Found ${mainContentCount} main content areas`);

      // Check for navigation elements using general selectors
      const navigationSelectors = [
        'nav',
        '[role="navigation"]',
        'header',
        '.sidebar',
        '.navigation',
        'aside',
      ].join(', ');

      const navigationCount = await page.locator(navigationSelectors).count();
      logger.debug(`Found ${navigationCount} navigation elements`);

      // Verify agent-related UI elements using general text-based selectors
      const agentsHeadingSelectors = ['h1, h2, h3', '[role="heading"]', '.heading', '.title'].join(
        ', '
      );

      // Check for agent/character heading text content
      const headings = await page.locator(agentsHeadingSelectors).allTextContents();
      const hasAgentHeading = headings.some(
        (text) => text.toLowerCase().includes('agent') || text.toLowerCase().includes('character')
      );

      logger.info(`Found headings: ${headings.join(', ')}`);

      // Look for agent cards or buttons using general selectors
      const agentCardSelectors = [
        '.card',
        '[role="button"]',
        'button',
        'a',
        '.agent-card',
        '.character-card',
        '.profile-card',
      ].join(', ');

      const agentCardCount = await page
        .locator(agentCardSelectors)
        .filter({ visible: true })
        .count();

      // Look for message-related UI elements
      const messageButtonSelectors = [
        'button:has-text("Message")',
        'button:has-text("Chat")',
        'a:has-text("Message")',
        'a:has-text("Chat")',
      ].join(', ');

      const messageButtonCount = await page.locator(messageButtonSelectors).count();

      logger.debug(
        `UI elements: ${hasAgentHeading ? 'Has agent headings' : 'No agent headings'}, ${agentCardCount} agent cards, ${messageButtonCount} message buttons`
      );

      // Verify at least one agent-related element is present
      expect(hasAgentHeading || agentCardCount > 0 || messageButtonCount > 0).toBeTruthy();

      // Verify interactive elements are present
      const interactiveSelectors = [
        'button',
        '[role="button"]',
        'a[href]',
        'input',
        'textarea',
        '.clickable',
        '[tabindex="0"]',
      ].join(', ');

      const buttonCount = await page.locator(interactiveSelectors).count();
      expect(buttonCount).toBeGreaterThan(0);
      logger.info(`Found ${buttonCount} interactive elements`);

      // Verify no console errors
      if (consoleErrors.length > 0) {
        logger.warn(`Found ${consoleErrors.length} console errors: ${consoleErrors.join(', ')}`);
      }
      expect(consoleErrors.length).toBe(0);

      logger.info('Homepage loaded successfully');
    } catch (error) {
      // Only take a screenshot in case of failure
      await page.screenshot({ path: 'screenshots/homepage-load-failed.png' });
      logger.error('Failed to verify web interface:', error);
      throw error;
    }
  });
});
