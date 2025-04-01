import { test, expect } from '@playwright/test';
import { waitForElizaInitialization, openCharacterInfo } from './utils';
import { logger } from './logger';

test.describe('UI - Character Information: Review Character Info Card', () => {
  // Increase timeout for this test
  test.setTimeout(60000);

  test('should display character information in the info panel', async ({ page }) => {
    try {
      // Navigate to the ElizaOS web interface
      await page.goto('/', { timeout: 30000 });
      logger.info('Navigated to ElizaOS web interface');

      // Wait for ElizaOS to initialize
      await waitForElizaInitialization(page);
      logger.info('ElizaOS initialization complete');

      // Open character info panel using utility function
      logger.info('Opening character info panel');
      await openCharacterInfo(page);

      // Add a small wait to ensure the info panel is fully visible
      await page.waitForTimeout(1000);

      // Check that the character info panel is open with more general selectors
      const infoPanel = await page
        .locator(
          ['div[role="dialog"]', 'div:has-text("About Me")', 'div:has-text("Status")'].join(', ')
        )
        .first();

      const infoPanelVisible = await infoPanel.isVisible().catch(() => false);
      expect(infoPanelVisible, 'Character info panel should be visible').toBeTruthy();
      logger.info('Character info panel is visible');

      // Check for common sections in info panels
      const sections = ['About Me', 'Status', 'Created', 'Plugins'];

      // Log the text content of the info panel for debugging
      const infoPanelText = await infoPanel.textContent();
      logger.info(`Info panel text content: ${infoPanelText?.substring(0, 200)}...`);

      // Check for at least one key section to verify it's the right type of panel
      let anySectionVisible = false;
      for (const section of sections) {
        const hasSection = await page
          .locator(`text=${section}`)
          .isVisible()
          .catch(() => false);
        if (hasSection) {
          anySectionVisible = true;
          logger.info(`Section "${section}" is present`);
        }
      }

      expect(anySectionVisible, 'At least one info panel section should be visible').toBeTruthy();

      // Check for character information like name or heading
      // Using very general heading selectors that should work in most UI designs
      const nameElement = await page
        .locator(
          'div[role="dialog"] h1, div[role="dialog"] h2, div[role="dialog"] h3, .dialog-title, .title, .heading'
        )
        .first();
      const nameVisible = await nameElement.isVisible().catch(() => false);

      if (nameVisible) {
        const name = await nameElement.textContent();
        logger.info(`Character name/heading: ${name}`);
        expect(name?.length, 'Character name/heading should not be empty').toBeGreaterThan(0);
      }

      // Check for content following the About Me section if it exists
      const aboutMeVisible = await page
        .locator('text=About Me')
        .isVisible()
        .catch(() => false);
      if (aboutMeVisible) {
        // Look for content near the About Me heading
        const bioContent = await page.evaluate(() => {
          const aboutMeElement = Array.from(document.querySelectorAll('*')).find((el) =>
            el.textContent?.includes('About Me')
          );
          if (aboutMeElement) {
            // Get the next sibling or parent's next child that might contain the bio
            const nextElement =
              aboutMeElement.nextElementSibling || aboutMeElement.parentElement?.nextElementSibling;
            return nextElement?.textContent || '';
          }
          return '';
        });

        if (bioContent) {
          logger.info(`Character bio content found: ${bioContent.substring(0, 50)}...`);
        }
      }

      logger.info('Character info panel validation complete');
    } catch (error) {
      // Only take a screenshot in case of failure
      await page.screenshot({ path: 'screenshots/character-info-error.png' });
      logger.error('Failed to validate character info panel:', error);
      throw error;
    }
  });
});
