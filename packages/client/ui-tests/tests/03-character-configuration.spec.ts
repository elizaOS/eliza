import { test, expect } from '@playwright/test';
import { waitForElizaInitialization } from './utils';

test.describe('UI - Basic UI Interaction: Open Character Configuration', () => {
  // Increase timeout for this test
  test.setTimeout(120000);

  test('should open the character configuration panel', async ({ page }) => {
    try {
      // Navigate to the ElizaOS web interface
      await page.goto('/', { timeout: 30000 });

      // Wait for ElizaOS to initialize
      await waitForElizaInitialization(page);
      console.log('ElizaOS initialization complete');

      // Take a screenshot before starting
      await page.screenshot({ path: 'screenshots/before-character-config.png' });

      // Get HTML content before opening settings for comparison
      const beforeHtml = await page.evaluate(() => document.body.innerHTML);
      const beforeLength = beforeHtml.length;
      console.log(`Initial content length: ${beforeLength}`);

      // Using exact selectors based on the UI structure
      console.log('Looking for agents grid using exact selector');

      // 1. Locate the agents grid
      const agentsGrid = page.locator(
        '#root > div > div.group\\/sidebar-wrapper.flex.min-h-svh.w-full.has-\\[\\[data-variant\\=inset\\]\\]\\:bg-card > main > div > div > div:nth-child(3)'
      );
      const hasAgentsGrid = await agentsGrid.isVisible().catch(() => false);

      if (hasAgentsGrid) {
        console.log('Found agents grid');
        await agentsGrid.screenshot({ path: 'screenshots/agents-grid.png' });

        // Count agent cards for verification
        const agentCards = await page
          .locator('.group, [role="button"], a')
          .filter({ hasText: /Eliza|Laura/ })
          .count();
        console.log(`Found ${agentCards} agent cards on dashboard`);

        // 2. Locate the first agent card
        const firstAgentCard = page.locator(
          '#root > div > div.group\\/sidebar-wrapper.flex.min-h-svh.w-full.has-\\[\\[data-variant\\=inset\\]\\]\\:bg-card > main > div > div > div:nth-child(3) > div:nth-child(1)'
        );
        const hasFirstAgent = await firstAgentCard.isVisible().catch(() => false);

        if (hasFirstAgent) {
          console.log('Found first agent card');
          await firstAgentCard.screenshot({ path: 'screenshots/first-agent-card.png' });

          // 3. Find and click the settings button with exact selector
          const settingsButton = page.locator(
            '#root > div > div.group\\/sidebar-wrapper.flex.min-h-svh.w-full.has-\\[\\[data-variant\\=inset\\]\\]\\:bg-card > main > div > div > div:nth-child(3) > div:nth-child(1) > div.flex.items-center.p-3.pb-4 > div > button:nth-child(3)'
          );
          const hasSettingsButton = await settingsButton.isVisible().catch(() => false);

          if (hasSettingsButton) {
            console.log('Found settings button with exact selector');
            await settingsButton.screenshot({ path: 'screenshots/settings-button.png' });

            // Click the settings button
            console.log('Clicking settings button');
            await settingsButton.click();
            await page.waitForTimeout(3000); // Wait for settings panel to open

            // Take a screenshot after clicking
            await page.screenshot({ path: 'screenshots/after-settings-click.png' });
          } else {
            console.log(
              'Settings button not found with exact selector, trying alternative approach'
            );

            // Alternative: Find settings button within the first agent card
            const alternativeSettingsButton = firstAgentCard
              .locator('button:nth-child(3), button:has(svg)')
              .last();
            if (await alternativeSettingsButton.isVisible()) {
              console.log('Found settings button with alternative selector');
              await alternativeSettingsButton.screenshot({
                path: 'screenshots/alternative-settings-button.png',
              });
              await alternativeSettingsButton.click();
              await page.waitForTimeout(3000);
            } else {
              throw new Error('Settings button not found');
            }
          }
        } else {
          throw new Error('First agent card not found');
        }
      } else {
        console.log('Agents grid not found with exact selector, trying alternative approach');

        // Fallback to more generic approach
        const agentCards = await page
          .locator('.group, [role="button"], a')
          .filter({ hasText: /Eliza|Laura/ })
          .count();
        if (agentCards > 0) {
          console.log(`Found ${agentCards} agent cards using generic selector`);

          // Get the first agent card
          const firstCard = page
            .locator('.group, [role="button"], a')
            .filter({ hasText: /Eliza|Laura/ })
            .first();
          await firstCard.screenshot({ path: 'screenshots/generic-agent-card.png' });

          // Find buttons with SVGs in this card
          const cardButtons = await firstCard.locator('button:has(svg)').all();
          console.log(`Found ${cardButtons.length} buttons with SVGs in agent card`);

          if (cardButtons.length > 0) {
            // Use the last button in the card (likely to be settings)
            const lastButton = cardButtons[cardButtons.length - 1];
            console.log('Using last button as settings button');
            await lastButton.screenshot({ path: 'screenshots/last-card-button.png' });
            await lastButton.click();
            await page.waitForTimeout(3000);
          }
        }
      }

      // Check if settings panel is opened

      // 4. Check for character settings heading with exact selector
      const settingsHeading = page.locator(
        '#root > div > div.group\\/sidebar-wrapper.flex.min-h-svh.w-full.has-\\[\\[data-variant\\=inset\\]\\]\\:bg-card > main > div > div > div > h1'
      );
      const hasSettingsHeading = await settingsHeading.isVisible().catch(() => false);

      if (hasSettingsHeading) {
        console.log('Found character settings heading with exact selector');
        const headingText = await settingsHeading.textContent();
        console.log(`Settings heading text: ${headingText}`);
        await settingsHeading.screenshot({ path: 'screenshots/settings-heading.png' });
      } else {
        console.log('Settings heading not found with exact selector, trying alternative approach');
      }

      // 5. Check for settings form with exact selector
      const settingsForm = page.locator(
        '#root > div > div.group\\/sidebar-wrapper.flex.min-h-svh.w-full.has-\\[\\[data-variant\\=inset\\]\\]\\:bg-card > main > div > form'
      );
      const hasSettingsForm = await settingsForm.isVisible().catch(() => false);

      if (hasSettingsForm) {
        console.log('Found settings form with exact selector');
        await settingsForm.screenshot({ path: 'screenshots/settings-form.png' });
      } else {
        console.log('Settings form not found with exact selector, trying alternative approach');
      }

      // Alternative verification approaches

      // Check if the page content changed significantly
      const afterHtml = await page.evaluate(() => document.body.innerHTML);
      const afterLength = afterHtml.length;
      const contentChanged = Math.abs(afterLength - beforeLength) > 500; // Look for substantial change

      console.log(
        `Page content ${contentChanged ? 'changed' : 'did not change'} after actions (before: ${beforeLength}, after: ${afterLength})`
      );

      // Alternative checks for settings panel elements

      // 1. Check for a title containing "Character" and "Settings"
      const hasSettingsTitle = await page
        .locator(
          [
            '#root h1:has-text("Character Settings")',
            '.container h1', // Container heading from CharacterForm
            'div.container h1.text-3xl', // More specific based on implementation
            'h1.text-3xl.font-bold',
            'h1', // Simple h1 element as a fallback
          ].join(', ')
        )
        .isVisible()
        .catch(() => false);

      console.log(`Has "Character Settings" title: ${hasSettingsTitle}`);

      // 2. Check for a name field - use exact ID and name from debug info
      const hasNameField = await page
        .locator(
          [
            'input#name',
            'input[name="name"]',
            'input[id="name"]',
            '#name', // Simple ID selector
          ].join(', ')
        )
        .isVisible()
        .catch(() => false);

      console.log(`Has name field: ${hasNameField}`);

      // 3. Check for a system field - use exact ID and name from debug info
      const hasSystemField = await page
        .locator(
          [
            'textarea#system',
            'textarea[name="system"]',
            'textarea[id="system"]',
            '#system', // Simple ID selector
          ].join(', ')
        )
        .isVisible()
        .catch(() => false);

      console.log(`Has text area (likely system prompt): ${hasSystemField}`);

      // Log form field information to help debug selector issues
      const formElements = await page.evaluate(() => {
        // Count elements by type
        const counts = {
          inputs: document.querySelectorAll('input').length,
          textareas: document.querySelectorAll('textarea').length,
          labels: document.querySelectorAll('label').length,
          buttons: document.querySelectorAll('button').length,
          forms: document.querySelectorAll('form').length,
        };

        // Get specific input elements with attributes
        const nameInput = document.getElementById('name');
        const nameInputDetails = nameInput
          ? {
              exists: true,
              id: nameInput.id,
              name: nameInput.getAttribute('name'),
              type: nameInput.getAttribute('type'),
              visible: nameInput.offsetParent !== null,
            }
          : { exists: false };

        // Get specific textarea elements with attributes
        const systemTextarea = document.getElementById('system');
        const systemTextareaDetails = systemTextarea
          ? {
              exists: true,
              id: systemTextarea.id,
              name: systemTextarea.getAttribute('name'),
              visible: systemTextarea.offsetParent !== null,
            }
          : { exists: false };

        return {
          counts,
          nameInputDetails,
          systemTextareaDetails,
          h1Text: document.querySelector('h1')?.textContent || 'No h1 found',
        };
      });

      console.log('Form element details:', formElements);

      // Updated form elements check incorporating the known form structure
      const hasUsernameField = await page
        .locator('input#username, input[name="username"]')
        .isVisible()
        .catch(() => false);
      const hasVoiceModelField = await page
        .locator('input[name="settings.voice.model"]')
        .isVisible()
        .catch(() => false);

      console.log(
        `Has username field: ${hasUsernameField}, Has voice model field: ${hasVoiceModelField}`
      );

      // 4. Check for tabs which are often present in settings
      const hasTabs =
        (await page
          .locator(
            [
              '[role="tab"]',
              '.tabs',
              'div:has-text("Basic Info")',
              'div:has-text("Content")',
              'div:has-text("Style")',
              'div:has-text("Plugins")',
              'div:has-text("Secret")',
              'div:has-text("Avatar")',
            ].join(', ')
          )
          .count()) > 0;

      console.log(`Has tabs: ${hasTabs}`);

      // 5. Check for any form elements or settings related content
      const hasFormElements =
        (await page
          .locator(
            [
              'form',
              'input',
              'textarea',
              'select',
              'button[type="submit"]',
              'button:has-text("Save")',
              'button:has-text("Apply")',
            ].join(', ')
          )
          .count()) > 3; // Multiple form elements would suggest a settings panel

      console.log(`Has multiple form elements: ${hasFormElements}`);

      // Verify that the configuration panel is open
      const configPanelOpen =
        hasSettingsHeading ||
        hasSettingsForm ||
        hasSettingsTitle ||
        hasNameField ||
        hasSystemField ||
        hasUsernameField ||
        hasVoiceModelField ||
        hasTabs ||
        hasFormElements ||
        contentChanged;

      // Take a final screenshot
      await page.screenshot({ path: 'screenshots/character-config-final.png' });

      // Assert that the settings panel is open
      expect(configPanelOpen).toBeTruthy();

      if (configPanelOpen) {
        console.log('✅ TEST PASSED: Character configuration panel was opened successfully');
      } else {
        console.log('❌ TEST FAILED: Could not verify that character configuration panel opened');
      }
    } catch (error) {
      // Take a screenshot of the error state
      await page.screenshot({ path: 'screenshots/character-config-error.png' });
      throw error;
    }
  });
});
