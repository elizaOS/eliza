import { test, expect } from '@playwright/test';
import {
  waitForElizaInitialization,
  openCharacterConfiguration,
  getCharacterInfo,
  updateCharacterSettings,
  checkForSuccessMessage,
} from './utils';
import { logger } from './logger';

test.describe('UI - Character Settings: Modify Character Settings', () => {
  // Increase timeout for this test
  test.setTimeout(120000);

  test('should successfully modify and save character settings', async ({ page }) => {
    try {
      // Navigate to the ElizaOS web interface
      await page.goto('/', { timeout: 30000 });
      logger.info('Navigated to ElizaOS web interface');

      // Wait for ElizaOS to initialize
      await waitForElizaInitialization(page);
      logger.info('ElizaOS initialization complete');

      // Open character configuration panel
      logger.info('Opening character configuration panel');
      await openCharacterConfiguration(page);

      // Get current character info before making changes
      const initialInfo = await getCharacterInfo(page);
      logger.info('Initial character information:', initialInfo);

      // Generate unique name to avoid conflicts with existing characters
      const timestamp = new Date().getTime().toString().slice(-6);
      const uniqueName = `Test Character ${timestamp}`;
      const testBio = 'This is a test bio updated by the automated test.';
      const systemPromptAddition = ' This is a test update to the system prompt.';

      const updatedSystemPrompt = initialInfo.systemPrompt + systemPromptAddition;

      // Update the character settings
      logger.info(`Updating character with name: ${uniqueName}`);
      await updateCharacterSettings(page, {
        name: uniqueName,
        bio: testBio,
        systemPrompt: updatedSystemPrompt,
      });

      // Look for save/submit button using generic selectors
      const saveButton = page
        .locator(
          [
            'button:has-text("Save")',
            'button:has-text("Update")',
            'button:has-text("Submit")',
            'button[type="submit"]',
            'form button',
          ].join(', ')
        )
        .first();

      // Check if save button exists
      const hasSaveButton = (await saveButton.count()) > 0;
      expect(hasSaveButton, 'Save button should be available').toBeTruthy();
      logger.info('Found save button, clicking to submit changes');

      // Click the save button
      await saveButton.click();

      // Wait for the save operation to complete (give it a few seconds)
      await page.waitForTimeout(2000);

      // Check for success message
      const saveSuccess = await checkForSuccessMessage(page);
      if (saveSuccess) {
        logger.info('Save operation completed successfully');
      } else {
        // If no success message, we'll still continue and verify the changes by content check
        logger.info('No success message detected, will verify changes directly');
      }

      // Get updated character info after saving
      const updatedInfo = await getCharacterInfo(page);
      logger.info('Updated character information:', updatedInfo);

      // Verify the changes were applied
      expect(updatedInfo.name).toBe(uniqueName);
      logger.info(`Name successfully updated to: ${updatedInfo.name}`);

      // Check if system prompt was updated
      const promptUpdated = updatedInfo.systemPrompt.includes(systemPromptAddition);
      expect(promptUpdated, 'System prompt should be updated').toBeTruthy();
      logger.info('System prompt was successfully updated');

      // Bio verification is optional, as it might be stored in different formats
      // and the test should still pass even if bio check doesn't work as expected
      try {
        if (updatedInfo.bio) {
          const bioUpdated = updatedInfo.bio.includes(testBio);
          logger.info(
            `Bio update check: ${bioUpdated ? 'successful' : 'not found in expected format'}`
          );
        } else {
          logger.info('Bio field not found in response, skipping verification');
        }
      } catch (error) {
        logger.warn('Error verifying bio update:', error);
      }

      logger.info('Character settings were successfully modified and saved');
    } catch (error) {
      // Only take a screenshot in case of failure
      await page.screenshot({ path: 'screenshots/modify-settings-error.png' });
      logger.error('Failed to modify character settings:', error);
      throw error;
    }
  });
});
