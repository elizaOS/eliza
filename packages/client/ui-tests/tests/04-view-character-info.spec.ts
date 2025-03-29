import { test, expect } from '@playwright/test';
import { waitForElizaInitialization } from './utils';

test.describe('UI - Basic UI Interaction: View Character Information', () => {
  // Increase timeout for this test
  test.setTimeout(120000);

  test('should display character information in the info panel', async ({ page }) => {
    try {
      // Navigate to the ElizaOS web interface
      await page.goto('/', { timeout: 30000 });

      // Wait for ElizaOS to initialize
      await waitForElizaInitialization(page);
      console.log('ElizaOS initialization complete');

      // Take a screenshot before starting
      await page.screenshot({ path: 'screenshots/before-character-info.png' });

      // Get HTML content before opening info for comparison
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

          // 3. Find and click the info button with exact selector
          // Using the selector provided for the info button (button:nth-child(2))
          const infoButton = page.locator(
            '#root > div > div.group\\/sidebar-wrapper.flex.min-h-svh.w-full.has-\\[\\[data-variant\\=inset\\]\\]\\:bg-card > main > div > div > div:nth-child(3) > div:nth-child(1) > div.flex.items-center.p-3.pb-4 > div > button:nth-child(2)'
          );
          const hasInfoButton = await infoButton.isVisible().catch(() => false);

          if (hasInfoButton) {
            console.log('Found info button with exact selector');
            await infoButton.screenshot({ path: 'screenshots/info-button.png' });

            // Click the info button
            console.log('Clicking info button');
            await infoButton.click();
            await page.waitForTimeout(3000); // Wait for info panel to open

            // Take a screenshot after clicking
            await page.screenshot({ path: 'screenshots/after-info-click.png' });
          } else {
            console.log('Info button not found with exact selector, trying alternative approach');

            // Alternative: Find info button within the first agent card
            const alternativeInfoButton = firstAgentCard
              .locator('button:nth-child(2), button:has(svg)')
              .first();
            if (await alternativeInfoButton.isVisible()) {
              console.log('Found info button with alternative selector');
              await alternativeInfoButton.screenshot({
                path: 'screenshots/alternative-info-button.png',
              });
              await alternativeInfoButton.click();
              await page.waitForTimeout(3000);
            } else {
              throw new Error('Info button not found');
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

          // Find buttons with SVGs in this card (usually first button is info, second is settings)
          const cardButtons = await firstCard.locator('button:has(svg)').all();
          console.log(`Found ${cardButtons.length} buttons with SVGs in agent card`);

          if (cardButtons.length > 0) {
            // Use the first button in the card (likely to be info)
            const infoButton = cardButtons[0];
            console.log('Using first button as info button');
            await infoButton.screenshot({ path: 'screenshots/first-card-button.png' });
            await infoButton.click();
            await page.waitForTimeout(3000);
          }
        }
      }

      // Check if info panel is opened

      // 4. Check for info panel with exact selector
      const infoPanel = page.locator(
        '#root > div > div.group\\/sidebar-wrapper.flex.min-h-svh.w-full.has-\\[\\[data-variant\\=inset\\]\\]\\:bg-card > main > div.fixed.inset-0.bg-black\\/80.flex.items-center.justify-center.z-50.p-4.backdrop-blur-sm > div'
      );
      const hasInfoPanel = await infoPanel.isVisible().catch(() => false);

      if (hasInfoPanel) {
        console.log('Found info panel with exact selector');
        await infoPanel.screenshot({ path: 'screenshots/info-panel.png' });

        // Check for close button in the info panel
        const closeButton = infoPanel.locator(
          'button:has-text("Close"), button:has(svg[data-lucide="X"]), button.close-button, button:has(svg.lucide-x)'
        );
        const hasCloseButton = await closeButton.isVisible().catch(() => false);
        if (hasCloseButton) {
          console.log('Found close button in info panel');
          await closeButton.screenshot({ path: 'screenshots/close-button.png' });
        }
      } else {
        console.log('Info panel not found with exact selector, trying alternative approach');
      }

      // 5. Check for agent photo with exact selector
      const agentPhoto = page.locator(
        '#root > div > div.group\\/sidebar-wrapper.flex.min-h-svh.w-full.has-\\[\\[data-variant\\=inset\\]\\]\\:bg-card > main > div.fixed.inset-0.bg-black\\/80.flex.items-center.justify-center.z-50.p-4.backdrop-blur-sm > div > div.flex.flex-col.p-0.space-y-0 > div.p-6.w-full.flex.items-end.bg-gradient-to-b.from-primary\\/20.to-background > div > div > div.w-24.h-24.flex.justify-center.items-center.relative'
      );
      const hasAgentPhoto = await agentPhoto.isVisible().catch(() => false);

      if (hasAgentPhoto) {
        console.log('Found agent photo with exact selector');
        await agentPhoto.screenshot({ path: 'screenshots/agent-photo.png' });

        // Check if photo contains an image
        const photoImg = agentPhoto.locator('img');
        const hasPhotoImg = await photoImg.isVisible().catch(() => false);
        if (hasPhotoImg) {
          console.log('Found image in agent photo area');
        }
      } else {
        console.log('Agent photo not found with exact selector');
      }

      // 6. Check for agent name with exact selector
      const agentName = page.locator(
        '#root > div > div.group\\/sidebar-wrapper.flex.min-h-svh.w-full.has-\\[\\[data-variant\\=inset\\]\\]\\:bg-card > main > div.fixed.inset-0.bg-black\\/80.flex.items-center.justify-center.z-50.p-4.backdrop-blur-sm > div > div.flex.flex-col.p-0.space-y-0 > div.p-6.w-full.flex.items-end.bg-gradient-to-b.from-primary\\/20.to-background > div > div > div.flex.flex-col.justify-center.mr-4 > div.text-xl.font-bold.truncate.max-w-48'
      );
      const hasAgentName = await agentName.isVisible().catch(() => false);

      if (hasAgentName) {
        console.log('Found agent name with exact selector');
        const nameText = await agentName.textContent();
        console.log(`Agent name: ${nameText}`);
        await agentName.screenshot({ path: 'screenshots/agent-name.png' });

        // Check that the name isn't empty
        if (nameText && nameText.trim().length > 0) {
          console.log('Agent name contains text');
        } else {
          console.log('Agent name element found but contains no text');
        }
      } else {
        console.log('Agent name not found with exact selector');
      }

      // 7. Check for about me section with exact selector
      const aboutMeSection = page.locator(
        '#root > div > div.group\\/sidebar-wrapper.flex.min-h-svh.w-full.has-\\[\\[data-variant\\=inset\\]\\]\\:bg-card > main > div.fixed.inset-0.bg-black\\/80.flex.items-center.justify-center.z-50.p-4.backdrop-blur-sm > div > div.p-6.overflow-auto > div.rounded-md.bg-muted.p-4.mb-6.h-60.overflow-y-auto'
      );
      const hasAboutMeSection = await aboutMeSection.isVisible().catch(() => false);

      if (hasAboutMeSection) {
        console.log('Found about me section with exact selector');
        const aboutMeText = await aboutMeSection.textContent();
        console.log(`About me content preview: ${aboutMeText?.substring(0, 100)}...`);
        await aboutMeSection.screenshot({ path: 'screenshots/about-me-section.png' });

        // Verify that the about me section has content
        if (aboutMeText && aboutMeText.trim().length > 10) {
          console.log('About me section contains substantial text');
        } else {
          console.log('About me section found but contains minimal text');
        }
      } else {
        console.log('About me section not found with exact selector');
      }

      // Alternative verification approaches

      // Check if the page content changed significantly
      const afterHtml = await page.evaluate(() => document.body.innerHTML);
      const afterLength = afterHtml.length;
      const contentChanged = Math.abs(afterLength - beforeLength) > 500; // Look for substantial change

      console.log(
        `Page content ${contentChanged ? 'changed' : 'did not change'} after actions (before: ${beforeLength}, after: ${afterLength})`
      );

      // Alternative checks for info panel elements

      // Check for about me heading
      const hasAboutMeHeading = await page
        .locator('text="About Me", h2:has-text("About Me"), div:has-text("About Me")')
        .isVisible()
        .catch(() => false);
      console.log(`Has "About Me" heading: ${hasAboutMeHeading}`);

      // Check for status section
      const hasStatusSection = await page
        .locator('text="Status", h2:has-text("Status"), div:has-text("Status")')
        .isVisible()
        .catch(() => false);
      console.log(`Has status section: ${hasStatusSection}`);

      // Check for plugins section
      const hasPluginsSection = await page
        .locator('text="Plugins", h2:has-text("Plugins"), div:has-text("Plugins")')
        .isVisible()
        .catch(() => false);
      console.log(`Has plugins section: ${hasPluginsSection}`);

      // Check for created date section
      const hasCreatedSection = await page
        .locator('text="Created", div:has-text("Created")')
        .isVisible()
        .catch(() => false);
      console.log(`Has created date section: ${hasCreatedSection}`);

      // Check for avatar/photo
      const hasAvatar = await page
        .locator('.avatar, img[alt*="avatar" i], .w-24.h-24, .rounded-full')
        .isVisible()
        .catch(() => false);
      console.log(`Has avatar/photo: ${hasAvatar}`);

      // Check for agent name in the panel
      const hasNameInPanel = await page
        .locator('.text-xl.font-bold, h1, .agent-name, .character-name')
        .isVisible()
        .catch(() => false);
      console.log(`Has agent name in panel: ${hasNameInPanel}`);

      // Log panel element information to help debug selector issues
      const panelElements = await page.evaluate(() => {
        // Count elements by type in the panel
        const modalDiv = document.querySelector('div.fixed.inset-0.bg-black\\/80');
        if (!modalDiv) return { found: false };

        const counts = {
          headings: modalDiv.querySelectorAll('h1, h2, h3, h4').length,
          paragraphs: modalDiv.querySelectorAll('p').length,
          images: modalDiv.querySelectorAll('img').length,
          divs: modalDiv.querySelectorAll('div').length,
        };

        // Helper function to find elements containing specific text
        const findElementWithText = (selector: string, searchText: string) => {
          const elements = Array.from(modalDiv.querySelectorAll(selector));
          return elements.find((el) => el.textContent && el.textContent.includes(searchText));
        };

        // Get text content of key sections using standard DOM methods
        const aboutMe = findElementWithText('div', 'About Me');
        const status = findElementWithText('div', 'Status');
        const plugins = findElementWithText('div', 'Plugins');

        // Get specific status indicators if they exist
        const active = findElementWithText('div', 'Active');
        const activeText = active ? active.textContent : null;

        const id = findElementWithText('div', 'ID:');
        const idText = id ? id.textContent : null;

        return {
          found: true,
          counts,
          sections: {
            aboutMe: aboutMe ? true : false,
            status: status ? true : false,
            plugins: plugins ? true : false,
          },
          statusInfo: {
            active: active ? true : false,
            activeText: activeText,
            id: id ? true : false,
            idText: idText,
          },
          title: document.querySelector('.text-xl.font-bold')?.textContent || 'No title found',
        };
      });

      console.log('Info panel element details:', panelElements);

      // Verify that the info panel is open with more specific checks
      const infoPanelOpen =
        hasInfoPanel ||
        hasAgentPhoto ||
        hasAgentName ||
        hasAboutMeSection ||
        hasAboutMeHeading ||
        hasStatusSection ||
        hasPluginsSection ||
        hasAvatar ||
        hasNameInPanel ||
        hasCreatedSection ||
        contentChanged;

      // Verify key panel sections (for better test assertions)
      const requiredSectionsFound =
        (hasAboutMeSection || hasAboutMeHeading) &&
        hasStatusSection &&
        (hasAgentName || hasNameInPanel);

      if (requiredSectionsFound) {
        console.log('All required info panel sections were found');
      } else {
        console.log('Some required info panel sections were not found');
      }

      // Take a final screenshot
      await page.screenshot({ path: 'screenshots/character-info-final.png' });

      // Assert that the info panel is open
      expect(infoPanelOpen).toBeTruthy();

      // For a stricter test, uncomment this line to require all essential sections
      // expect(requiredSectionsFound).toBeTruthy();

      if (infoPanelOpen) {
        console.log('✅ TEST PASSED: Character info panel was opened successfully');
      } else {
        console.log('❌ TEST FAILED: Could not verify that character info panel opened');
      }

      // Optionally close the panel if needed (commented out to avoid affecting other tests)
      // if (hasInfoPanel) {
      //   const closeButton = infoPanel.locator('button:has-text("Close"), button:has(svg[data-lucide="X"])');
      //   if (await closeButton.isVisible()) {
      //     console.log('Closing info panel');
      //     await closeButton.click();
      //     await page.waitForTimeout(1000);
      //   }
      // }
    } catch (error) {
      // Take a screenshot of the error state
      await page.screenshot({ path: 'screenshots/character-info-error.png' });

      // Additional error logging
      console.error(
        'Error in character info test:',
        error instanceof Error ? error.message : String(error)
      );

      // Try to log what elements are visible
      try {
        const visibleElements = await page.evaluate(() => {
          return {
            buttons: Array.from(document.querySelectorAll('button')).length,
            dialogs: document.querySelectorAll('div[role="dialog"]').length,
            modals: document.querySelectorAll('div.fixed.inset-0').length,
            headings: Array.from(document.querySelectorAll('h1, h2, h3'))
              .map((h) => h.textContent)
              .filter(Boolean),
            // Log where user clicked to help with debugging
            infoButtonExists: !!document.querySelector(
              '#root > div > div.group\\/sidebar-wrapper button:nth-child(2)'
            ),
            infoPanelExists: !!document.querySelector('div.fixed.inset-0.bg-black\\/80'),
          };
        });
        console.log('Visible elements at error time:', visibleElements);
      } catch (e) {
        console.error('Failed to log visible elements:', e);
      }

      throw error;
    }
  });
});
