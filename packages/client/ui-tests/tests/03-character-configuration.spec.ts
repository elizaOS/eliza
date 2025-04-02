import { test, expect } from '@playwright/test';
import { waitForElizaInitialization, openCharacterConfiguration } from './utils';
import { logger } from './logger';

test.describe('UI - Basic UI Interaction: Open Character Configuration', () => {
  // Increase timeout for this test
  test.setTimeout(120000);

  test('should open the character configuration panel', async ({ page }) => {
    try {
      // Navigate to the ElizaOS web interface
      await page.goto('/', { timeout: 30000 });
      logger.info('Navigated to ElizaOS web interface');

      // Wait for ElizaOS to initialize
      await waitForElizaInitialization(page);
      logger.info('ElizaOS initialization complete');

      // Use the utility function to open character settings
      logger.info('Opening character configuration panel');
      await openCharacterConfiguration(page);

      // Verify settings panel is open with minimal verification
      const formElements = await page
        .locator('form:has(input[name="name"]), input[name="name"], textarea[name="system"]')
        .count();
      const settingsPanelVisible = formElements > 0;

      expect(settingsPanelVisible, 'Character configuration panel was not found').toBeTruthy();
      logger.info('Character configuration panel successfully validated');
    } catch (error) {
      // Take a screenshot on failure
      await page.screenshot({ path: 'screenshots/error-character-config-error.png' });
      logger.error('Failed to validate character configuration panel:', error);
      throw error;
    }
  });
});
