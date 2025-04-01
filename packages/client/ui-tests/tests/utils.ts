import { Page, expect } from '@playwright/test';
import { logger } from './logger';

/**
 * Wait for ElizaOS to fully initialize
 */
export async function waitForElizaInitialization(page: Page): Promise<void> {
  logger.info('Waiting for ElizaOS to initialize...');

  try {
    // Wait for any main UI element to load - using broader selectors
    await page.waitForSelector(
      [
        // Root application containers
        '#root',
        '.app',
        '[role="application"]',
        // Main content containers
        'main',
        '[role="main"]',
        // Any primary UI containers
        '.main-content',
        '.dashboard',
        // Interactive elements
        'textarea, input, button[role="button"]',
        // Navigation elements
        'nav',
        '[role="navigation"]',
        // For debugging just wait for any content
        'body > div',
      ].join(', '),
      { timeout: 60000 }
    ); // 60 second timeout

    // Log available elements for assertion
    const elementCount = await page.evaluate(() => {
      const counts = {
        divs: document.querySelectorAll('div').length,
        inputs: document.querySelectorAll('input, textarea').length,
        buttons: document.querySelectorAll('button, [role="button"]').length,
        navigation: document.querySelectorAll('nav, [role="navigation"], header, .sidebar, aside')
          .length,
        headings: document.querySelectorAll('h1, h2, h3, [role="heading"]').length,
      };
      return counts;
    });

    logger.info('Page elements found:', elementCount);

    // Small delay to ensure UI has fully rendered
    await page.waitForTimeout(2000);

    logger.info('ElizaOS initialization complete');
  } catch (error) {
    logger.error('Error during initialization:', error);
    throw error;
  }
}

/**
 * Send a message in the chat interface and wait for a response
 */
export async function sendMessageAndWaitForResponse(page: Page, message: string): Promise<string> {
  logger.info(`Attempting to send message: "${message}"`);

  try {
    // Find the input field using broader selectors
    const inputSelectors = [
      // Specific attribute selectors
      'textarea[name="message"]',
      'textarea[placeholder*="message"]',
      'textarea[placeholder*="type"]',
      'input[type="text"]',
      // General element selectors
      'textarea',
      'input:not([type="hidden"])',
      // ARIA attributes
      '[role="textbox"]',
      '[contenteditable="true"]',
      // Specific class-based selectors from the UI
      '.chat-input',
      '.message-input',
    ].join(', ');

    // Log the number of input fields found
    const inputCount = await page.locator(inputSelectors).count();
    logger.info(`Found ${inputCount} possible input fields`);

    if (inputCount === 0) {
      logger.error('No input field found');
      throw new Error('No input field found for sending message');
    }

    // Use the first input field found
    const inputField = page.locator(inputSelectors).first();
    await inputField.fill(message);

    // Try to find send button with generalizable selectors
    const sendButtonSelectors = [
      // Text-based selectors
      'button:has-text("Send")',
      'button:has-text("Submit")',
      // ARIA attributes
      'button[aria-label="Send"]',
      'button[aria-label="Submit"]',
      '[role="button"][aria-label="Send"]',
      // Class-based selectors
      'button.send-button',
      '.send-button',
      // Form control selectors
      'button[type="submit"]',
      'input[type="submit"]',
      // Icon-based selectors
      'button:has(svg)',
      // Position-based for chat UIs (usually button is placed right after input)
      'textarea + button',
      '.chat-input-container > button',
    ].join(', ');

    const hasSendButton = (await page.locator(sendButtonSelectors).count()) > 0;

    // Either click send button or press Enter
    if (hasSendButton) {
      logger.info('Using send button to submit message');
      await page.locator(sendButtonSelectors).first().click();
    } else {
      logger.info('Using Enter key to submit message');
      await inputField.press('Enter');
    }

    // Wait for the response to appear
    logger.info('Waiting for response...');

    // First confirm our message appeared in the chat
    const pageContentBefore = (await page.textContent('body')) || '';
    if (!pageContentBefore.includes(message)) {
      // Wait briefly and check again
      await page.waitForTimeout(2000);
      const pageContentRetry = (await page.textContent('body')) || '';
      if (!pageContentRetry.includes(message)) {
        logger.warn('Message may not have been sent properly - not found in page content');
      }
    }

    // Wait for a reasonable timeout for response
    await page.waitForTimeout(10000);

    // Get the new content and compare with previous
    const pageContentAfter = (await page.textContent('body')) || '';

    // Check if there's more content (indicating a response)
    if (pageContentAfter.length <= pageContentBefore.length) {
      logger.warn('No additional content detected after waiting for response');
    }

    // Try to get specific response text if possible
    let responseText = '';
    try {
      // Try various selectors to locate the response
      const responseSelectors = [
        // Class-based selectors (from inspecting the UI components)
        '.chat-bubble[data-variant="received"]:last-child',
        '.chat-bubble:not([data-variant="sent"]):last-child',
        // Structure-based selectors
        '.chat-message:not(:has-text("' + message + '")):last-child',
        '.message:not(:has-text("' + message + '")):last-child',
        // General HTML structure
        'div > p:not(:has-text("' + message + '"))',
        // More general fallbacks
        '.agent-message',
        '.bot-message',
        '.assistant-message',
      ].join(', ');

      const responseElement = page.locator(responseSelectors);
      if ((await responseElement.count()) > 0) {
        responseText = (await responseElement.textContent()) || '';
        logger.info(`Found response text: "${responseText.substring(0, 30)}..."`);
      } else {
        // Extract reasonable response by comparing before/after content
        responseText = pageContentAfter.replace(pageContentBefore, '').trim();
        logger.info('Extracted response by content difference');
      }
    } catch (error) {
      logger.warn('Failed to extract specific response:', error);
      // Return generic response indication
      return 'Response received but could not extract specific text';
    }

    return responseText || 'Response received';
  } catch (error) {
    logger.error('Error sending message or receiving response:', error);
    throw error;
  }
}

/**
 * Open the character configuration panel
 */
export async function openCharacterConfiguration(page: Page): Promise<void> {
  logger.info('Opening character configuration...');

  try {
    // Check if already on settings page
    const alreadyOnSettings = await page
      .locator(
        'div:has-text("Character Settings"), form:has([name="name"]), div[role="dialog"]:has(input[name="name"]), .character-form, .character-settings'
      )
      .isVisible()
      .catch(() => false);

    if (alreadyOnSettings) {
      logger.info('Already on character settings page');
      return;
    }

    // Check if settings panel is already open
    const settingsPanelAlreadyVisible = await page.evaluate(() => {
      return document.body.innerHTML.includes('Character Settings');
    });

    if (settingsPanelAlreadyVisible) {
      logger.info('Settings panel already visible, no need to open it again');
      return;
    }

    // Figure out where we are - dashboard or chat view
    const onDashboard = await page.evaluate(() => {
      return !window.location.pathname.includes('/chat/');
    });

    if (onDashboard) {
      logger.info('On dashboard, clicking settings icon for an agent');

      // IMPROVED AGENT CARD SELECTOR
      // Use more specific selectors to avoid picking sidebar elements
      const agentCardSelector = [
        // Main grid items - very specific to dashboard layout
        '.grid .card',
        '.grid-cols-1 > div',
        '.grid-cols-2 > div',
        '.grid-cols-3 > div',
        // Agent cards typically have these properties
        'div.w-full.p-4',
        'div.relative.rounded-lg',
        // Specifically exclude sidebar elements
        'main div:not(nav *):not(aside *):not(header *):has(button:has-text("Message"))',
      ].join(', ');

      // Get potential agent cards
      const potentialCards = await page.locator(agentCardSelector).all();
      logger.info(`Found ${potentialCards.length} potential agent cards on dashboard`);

      // Additional filter to ensure we're getting real agent cards that have the Message button
      const agentCards = [];
      for (const card of potentialCards) {
        const hasMessageButton = (await card.locator('button:has-text("Message")').count()) > 0;
        const inSidebar = await card.evaluate((node: HTMLElement) => {
          // Check if this element is inside a sidebar, nav, or header
          let parent = node;
          while (parent && parent !== document.body) {
            const tagName = parent.tagName.toLowerCase();
            const role = parent.getAttribute('role');
            const className = parent.className || '';

            if (
              tagName === 'nav' ||
              tagName === 'aside' ||
              tagName === 'header' ||
              role === 'navigation' ||
              className.includes('sidebar') ||
              className.includes('navigation')
            ) {
              return true; // It's in a sidebar
            }
            parent = parent.parentElement as HTMLElement;
          }
          return false; // Not in a sidebar
        });

        if (hasMessageButton && !inSidebar) {
          agentCards.push(card);
        }
      }

      logger.info(`Found ${agentCards.length} verified agent cards on dashboard`);

      // If no verified cards found, try a more direct approach
      if (agentCards.length === 0) {
        logger.info('No verified agent cards found, trying direct approach with Message buttons');

        // Look for any Message button not in sidebar
        const messageButtons = await page.locator('button:has-text("Message")').all();
        logger.info(`Found ${messageButtons.length} Message buttons in total`);

        for (let i = 0; i < messageButtons.length; i++) {
          const buttonBounds = await messageButtons[i].boundingBox();
          if (buttonBounds) {
            // Skip buttons that are likely in the sidebar (typically on the left side)
            if (buttonBounds.x > 200) {
              // Assume sidebar is less than 200px wide
              // Get closest parent that could be a card
              const buttonText = (await messageButtons[i].textContent()) || '';
              const possibleCard = page
                .locator(`div:has(button:has-text("${buttonText}"))`)
                .first();

              if ((await possibleCard.count()) > 0) {
                agentCards.push(possibleCard);
                logger.info(`Added agent card based on Message button at x=${buttonBounds.x}`);
                break;
              }
            }
          }
        }
      }

      if (agentCards.length === 0) {
        logger.error('No agent cards found after multiple attempts');
        throw new Error('No agent cards found on dashboard');
      }

      // Get the first agent card
      const firstAgentCard = agentCards[0];

      // Find all buttons in the card
      const allButtons = await firstAgentCard.locator('button').all();
      logger.info(`Found ${allButtons.length} buttons in the agent card`);

      // IMPROVED SETTINGS BUTTON DETECTION
      // First try to find by Cog icon (most reliable)
      const cogButtons = await firstAgentCard
        .locator('button:has(svg[data-lucide="Cog"]), button:has(svg.lucide-cog)')
        .all();
      logger.info(`Found ${cogButtons.length} buttons with Cog icon in the card`);

      let settingsButton = null;

      if (cogButtons.length > 0) {
        // Multiple cog buttons found - need to determine which is the settings button
        let settingsButtonIndex = 0; // Default to first one

        // If we have multiple buttons, try to find the one in the card footer
        if (cogButtons.length > 1) {
          const messageButton = await firstAgentCard.locator('button:has-text("Message")').first();
          const msgBounds = await messageButton.boundingBox();

          if (msgBounds) {
            logger.info(`Message button position: x=${msgBounds.x}, y=${msgBounds.y}`);

            // Get positions of all cog buttons
            const buttonPositions = [];
            for (let i = 0; i < cogButtons.length; i++) {
              const btnBounds = await cogButtons[i].boundingBox();
              if (btnBounds) {
                // Calculate horizontal and vertical distance from message button
                const xDist = btnBounds.x - msgBounds.x;
                const yDist = Math.abs(btnBounds.y - msgBounds.y);

                buttonPositions.push({
                  index: i,
                  x: btnBounds.x,
                  y: btnBounds.y,
                  xDist,
                  yDist,
                });

                logger.info(
                  `Cog button ${i} position: x=${btnBounds.x}, y=${btnBounds.y}, xDist=${xDist}, yDist=${yDist}`
                );
              }
            }

            // Sort the buttons by how close they are to the message button horizontally
            // (but only if they're roughly at the same vertical position)
            const sameLevelButtons = buttonPositions.filter((btn) => btn.yDist < 50);
            if (sameLevelButtons.length > 0) {
              // Sort by x position (rightmost should be settings)
              sameLevelButtons.sort((a, b) => b.x - a.x);
              settingsButtonIndex = sameLevelButtons[0].index;
              logger.info(
                `Selected rightmost cog button at same level as Message button: index ${settingsButtonIndex}`
              );
            } else {
              // If none at same level, use the button furthest to the right
              buttonPositions.sort((a, b) => b.x - a.x);
              settingsButtonIndex = buttonPositions[0].index;
              logger.info(
                `No cog buttons at same level, using rightmost: index ${settingsButtonIndex}`
              );
            }
          }
        }

        settingsButton = cogButtons[settingsButtonIndex];
      }
      // If no Cog icon, try positional approaches
      else {
        logger.info('No Cog buttons found, trying positional approach');

        // Try to use the last/rightmost button
        const messageButton = await firstAgentCard.locator('button:has-text("Message")').first();
        const msgBounds = await messageButton.boundingBox();

        if (msgBounds) {
          // Get all buttons with SVGs (icon buttons)
          const iconButtons = await firstAgentCard.locator('button:has(svg)').all();
          logger.info(`Found ${iconButtons.length} icon buttons in the card`);

          // A typical agent card should have 3 buttons: Message, Info, Settings
          // The Settings button should be the last one
          if (iconButtons.length >= 3) {
            const potentialSettingsButtons = iconButtons.filter(async (btn) => {
              const text = await btn.textContent();
              return !text?.includes('Message'); // Exclude Message button
            });

            if (potentialSettingsButtons.length >= 2) {
              // The third button (or last button) should be settings
              settingsButton = potentialSettingsButtons[potentialSettingsButtons.length - 1];
              logger.info('Selected last button with icon as settings button');
            }
          }

          // If still no button found, use button positions
          if (!settingsButton && iconButtons.length > 0) {
            // Collect all button positions and find the rightmost
            const buttonPositions = [];

            for (const btn of iconButtons) {
              const btnBounds = await btn.boundingBox();
              if (btnBounds) {
                // Only consider buttons at similar vertical position to Message
                const yDist = Math.abs(btnBounds.y - msgBounds.y);
                if (yDist < 50) {
                  buttonPositions.push({ button: btn, x: btnBounds.x });
                }
              }
            }

            // Sort by X position (rightmost should be settings)
            buttonPositions.sort((a, b) => b.x - a.x);

            if (buttonPositions.length > 0) {
              settingsButton = buttonPositions[0].button;
              logger.info('Selected rightmost button as settings button');
            }
          }
        }
      }

      // Click the settings button if found
      if (settingsButton) {
        logger.info('Clicking identified settings button');
        await settingsButton.click();
        await page.waitForTimeout(2000);
      } else {
        logger.info('No suitable settings button found using spatial analysis');

        // Continue to fallbacks below
        logger.info('Using fallback approaches to find settings button');

        // We'll keep the fallback logic from our previous implementation:
        // 1. Look for any buttons with cog icons that are not in the top navigation
        const cogButtons = await page
          .locator('button:has(svg[data-lucide="Cog"]), button:has(svg.lucide-cog)')
          .all();
        logger.info(`Found ${cogButtons.length} buttons with cog icons`);

        let cogButtonFound = false;

        for (const btn of cogButtons) {
          const btnBounds = await btn.boundingBox();
          // Skip buttons in the top area (likely navigation)
          if (btnBounds && btnBounds.y > 150) {
            // Skip top navigation
            logger.info('Found cog button below top navigation');
            await btn.click();
            await page.waitForTimeout(2000);
            cogButtonFound = true;
            break;
          }
        }

        // 2. If no cog button found, try clicking Message first, then settings in chat view
        if (!cogButtonFound) {
          logger.info('No cog button found, trying to go to chat view first');
          const messageButton = page.locator('button:has-text("Message")').first();
          if ((await messageButton.count()) > 0) {
            logger.info('Found Message button, clicking it to enter chat view');
            await messageButton.click();
            await page.waitForTimeout(2000);

            // Now try to find settings button in chat view
            const chatSettingsButton = page.locator('button:has(svg[data-lucide="Cog"])').first();
            logger.info('Looking for settings button in chat view');

            if ((await chatSettingsButton.count()) > 0) {
              logger.info('Found settings in chat view, clicking it');
              await chatSettingsButton.click();
              await page.waitForTimeout(2000);
            } else {
              logger.info('No settings button found in chat view, trying SVG buttons');
              // Try all buttons with SVGs
              const svgButtons = await page.locator('button:has(svg)').all();

              if (svgButtons.length > 0) {
                // First button is likely info
                logger.info('Clicking first button with SVG (likely info)');
                await svgButtons[0].click();
                await page.waitForTimeout(2000);
              }
            }
          }
        }
      }
    } else {
      // If we're not on dashboard, try more traditional selectors
      logger.info('Not on dashboard, trying traditional navigation');
      const configButton = page
        .locator(
          'button:has(svg[data-lucide="Cog"]), button.config-button, button:has-text("Settings"), [aria-label="Settings"]'
        )
        .first();

      if ((await configButton.count()) > 0) {
        logger.info('Found settings button, clicking it');
        await configButton.click();
        await page.waitForTimeout(2000);
      }
    }

    // Wait for panel to be confirmed visible based on content
    try {
      // Wait for character form elements to be visible
      await page.waitForSelector(
        'input[name="name"], textarea[name="system"], form:has(input[name="name"]), [role="dialog"]:has(input[name="name"])',
        {
          timeout: 10000,
        }
      );
      logger.info('Character configuration panel confirmed visible');
    } catch (error) {
      // On error, take a screenshot and throw
      await page.screenshot({ path: 'screenshots/panel-not-confirmed.png' });
      throw new Error('Character configuration panel did not appear as expected: ' + error);
    }

    // Add a small delay to ensure the panel is fully loaded/rendered
    await page.waitForTimeout(1000);

    // Give a final status update
    logger.info('Character configuration panel successfully opened');
  } catch (error) {
    // Capture a screenshot on error
    await page.screenshot({ path: 'screenshots/character-config-error.png' });
    logger.error('Error opening character configuration:', error);
    throw error;
  }
}

/**
 * Get character information from either the configuration panel or info panel
 */
export async function getCharacterInfo(
  page: Page
): Promise<{ name: string; bio: string; systemPrompt: string }> {
  logger.info('Attempting to get character information...');

  try {
    // Ensure the panel is visible
    const confirmPanelSelector =
      'form:has(input[name="name"]), [role="dialog"]:has(input[name="name"]), input[name="name"], textarea[name="system"]';
    const panelVisible = await page
      .locator(confirmPanelSelector)
      .isVisible()
      .catch(() => false);

    if (!panelVisible) {
      logger.error('Character configuration panel is not visible');
      await page.screenshot({ path: 'screenshots/panel-detection-issue.png' });
      throw new Error('Character configuration panel not detected');
    }

    // First determine if we're in settings or info panel
    const inSettingsPanel = await page
      .locator('div:has-text("Character Settings")')
      .first()
      .isVisible()
      .catch(() => false);
    const inInfoPanel = await page
      .locator('div[role="dialog"]:has-text("About Me")')
      .first()
      .isVisible()
      .catch(() => false);

    logger.info(`Current UI state: Settings panel: ${inSettingsPanel}, Info panel: ${inInfoPanel}`);

    let name = '';
    let bio = '';
    let systemPrompt = '';

    if (inSettingsPanel) {
      // We're in the settings panel
      logger.info('Getting info from settings panel');

      // Get name from name field
      name = await page
        .locator(
          [
            'input[name="name"]',
            '[data-testid="character-name"]',
            'input#name',
            'h2:has-text("Character Settings") + div input',
          ].join(', ')
        )
        .inputValue()
        .catch(() => '');

      // Try to get bio based on text content if it's not editable
      if (name === '') {
        name = (await page.locator('div:has-text("Name") + div').textContent()) || '';
        name = name.trim();
      }

      // Get system prompt from textarea
      systemPrompt = await page
        .locator(
          [
            'textarea[name="system"]',
            'textarea[name="systemPrompt"]',
            '[data-testid="character-system-prompt"]',
            '.system-input textarea',
            'div:has-text("System") + div textarea',
            'textarea:below(:text("System prompt"))',
          ].join(', ')
        )
        .inputValue()
        .catch(() => '');

      // Get bio from textarea or text content
      try {
        bio = await page
          .locator(
            [
              'textarea[name="bio"]',
              '[data-testid="character-bio"]',
              '.bio-input textarea',
              'div:has-text("Bio") + div textarea',
              // For ArrayInput bio items
              '[data-path="bio"] input',
            ].join(', ')
          )
          .first()
          .inputValue()
          .catch(() => '');
      } catch (e) {
        // Bio might be in an array input or not present
        try {
          const bioItems = await page
            .locator('[data-path="bio"] input, .array-input[data-name="bio"] input')
            .allTextContents();
          bio = bioItems.join(' ');
        } catch (err) {
          bio = '';
        }
      }
    } else if (inInfoPanel) {
      // We're in the info panel
      logger.info('Getting info from info panel');

      // Get name from header
      name =
        (await page
          .locator(
            [
              'div[role="dialog"] h2',
              'div[role="dialog"] h3',
              '.dialog-title',
              'div[role="dialog"] .name',
            ].join(', ')
          )
          .textContent()
          .catch(() => '')) || '';

      if (name) {
        name = name.trim();
      }

      // Get bio from the About Me section
      bio =
        (await page
          .locator(
            ['div:has-text("About Me") + div', '.about-me', '.bio', '.profile-bio'].join(', ')
          )
          .textContent()
          .catch(() => '')) || '';

      if (bio) {
        bio = bio.trim();
      }

      // System prompt usually isn't shown in info panel
      systemPrompt = '';
    } else {
      logger.warn('Neither settings nor info panel detected. Taking screenshot for debugging.');
      await page.screenshot({ path: 'screenshots/panel-detection-issue.png' });
    }

    return {
      name: name || '',
      bio: bio || '',
      systemPrompt: systemPrompt || '',
    };
  } catch (error) {
    // Take a screenshot on error
    await page.screenshot({ path: 'screenshots/get-character-info-error.png' });
    logger.error('Error getting character info:', error);
    throw error;
  }
}

/**
 * Update character settings
 */
export async function updateCharacterSettings(
  page: Page,
  settings: { name?: string; bio?: string; systemPrompt?: string }
): Promise<void> {
  // Update fields using selectors based on CHARACTER_FORM_SCHEMA
  if (settings.name) {
    await page
      .locator(['input[name="name"]', '[data-testid="character-name"]', 'input#name'].join(', '))
      .fill(settings.name);
  }

  if (settings.bio) {
    // Try to locate bio field
    const bioField = page
      .locator(
        [
          'textarea[name="bio"]',
          '[data-testid="character-bio"]',
          '.bio-input textarea',
          // For ArrayInput first item
          '[data-path="bio"] input:first-child, .array-input[data-name="bio"] input:first-child',
        ].join(', ')
      )
      .first();

    if ((await bioField.count()) > 0) {
      await bioField.fill(settings.bio);
    } else {
      // Bio might be in an array input
      // Try to find an "Add" button and create a new item
      const addButton = page.locator(
        '[data-path="bio"] button:has-text("Add"), .array-input[data-name="bio"] button:has-text("Add")'
      );
      if ((await addButton.count()) > 0) {
        await addButton.click();
        await page
          .locator(
            '[data-path="bio"] input:first-child, .array-input[data-name="bio"] input:first-child'
          )
          .fill(settings.bio);
      }
    }
  }

  if (settings.systemPrompt) {
    await page
      .locator(
        [
          'textarea[name="system"]',
          'textarea[name="systemPrompt"]',
          '[data-testid="character-system-prompt"]',
          '.system-input textarea',
        ].join(', ')
      )
      .fill(settings.systemPrompt);
  }

  // Find and click the save button
  const saveButton = page
    .locator(
      [
        'button:has-text("Save")',
        'button:has-text("Apply")',
        'button[type="submit"]',
        'form button:not(:has-text("Cancel"))',
      ].join(', ')
    )
    .first();

  await saveButton.click();

  // Wait for save confirmation or for the panel to close
  await page.waitForTimeout(1000); // Brief wait for UI update
}

/**
 * Check if success message is displayed
 */
export async function checkForSuccessMessage(page: Page): Promise<boolean> {
  try {
    await page.waitForSelector(
      [
        'div[role="alert"]:has-text("success")',
        '.toast:has-text("success")',
        '.toast-success',
        '.notification:has-text("success")',
      ].join(', '),
      { timeout: 5000 }
    );
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Opens the memory management panel
 */
export async function openMemoryViewer(page: Page): Promise<void> {
  const memoryButton = page
    .locator('button:has-text("Memory"), [role="tab"]:has-text("Memory")')
    .first();
  await memoryButton.click();

  // Wait for memory viewer to load
  await page.waitForSelector('.memory-list, .memory-viewer', { timeout: 5000 });
}

/**
 * Open agent settings panel
 */
export async function openAgentSettings(page: Page): Promise<void> {
  // Find and click the agent settings button
  const settingsButton = page.locator(
    'button:has-text("Settings"), button:has-text("Agent Settings"), [aria-label="Agent Settings"]'
  );
  await settingsButton.click();

  // Wait for settings panel to open
  await page.waitForSelector('.agent-settings, [role="dialog"]:has-text("Settings")', {
    timeout: 5000,
  });
}

/**
 * Open the character info panel
 */
export async function openCharacterInfo(page: Page): Promise<void> {
  logger.info('Opening character info panel...');

  try {
    // Check if info panel is already visible using more general selectors
    const infoDialogAlreadyVisible = await page
      .locator(
        [
          'div[role="dialog"]',
          '.modal',
          'div:has-text("About Me")',
          'div:has(h2):has-text("Status")',
        ].join(', ')
      )
      .isVisible()
      .catch(() => false);

    if (infoDialogAlreadyVisible) {
      logger.info('Info panel already visible, no need to open it again');
      return;
    }

    // Figure out where we are - dashboard or chat view
    const onDashboard = await page.evaluate(() => {
      return !window.location.pathname.includes('/chat/');
    });

    if (onDashboard) {
      logger.info('On dashboard, attempting to open character info');

      // Use a more reliable way to find agent cards
      const messageButtons = await page.locator('button:has-text("Message")').all();
      logger.info(`Found ${messageButtons.length} Message buttons in total`);

      if (messageButtons.length === 0) {
        throw new Error('No Message buttons found on dashboard');
      }

      // Get the first Message button's parent container (likely an agent card)
      const msgButton = messageButtons[0];

      // Find the parent agent card using a general selector
      const agentCard = page.locator('div:has(button:has-text("Message"))').first();

      // Look for any button that isn't the message button - this is likely the info button
      // Using very general selectors here
      const potentialInfoButtons = await agentCard
        .locator('button:not(:has-text("Message")), a[role="button"]:not(:has-text("Message"))')
        .all();

      logger.info(`Found ${potentialInfoButtons.length} potential info buttons in the card`);

      if (potentialInfoButtons.length > 0) {
        // Use the first non-message button found
        const infoButton = potentialInfoButtons[0];
        logger.info('Found potential info button, clicking it');

        await infoButton.click();
        await page.waitForTimeout(1000);

        // Check if the info panel opened using general content checks
        const infoPanel = await page
          .locator('div:has-text("About Me"), div:has-text("Status"), div[role="dialog"]')
          .isVisible()
          .catch(() => false);

        if (!infoPanel) {
          logger.warn('Info panel not immediately visible, trying alternative approach');

          // Try clicking another potential button if available
          if (potentialInfoButtons.length > 1) {
            logger.info('Trying second potential info button');
            await potentialInfoButtons[1].click();
            await page.waitForTimeout(1000);
          }
        }
      } else {
        throw new Error('Could not find any potential info buttons on agent card');
      }
    } else {
      // In chat view, find any button in the header area that could be the info button
      logger.info('In chat view, looking for info button in header');

      // Look for buttons in the header area, excluding those with clear other purposes
      const headerButtons = await page
        .locator('header button, nav button, .header button, .navbar button')
        .all();

      logger.info(`Found ${headerButtons.length} buttons in header area`);

      // Try to find a button that looks like an info button
      let infoButton = null;

      for (const button of headerButtons) {
        const buttonText = (await button.textContent()) || '';
        if (
          buttonText.includes('Info') ||
          buttonText.trim() === '' || // Empty buttons are often icon buttons
          buttonText.length < 3
        ) {
          infoButton = button;
          break;
        }
      }

      if (infoButton) {
        logger.info('Found potential info button in chat view, clicking it');
        await infoButton.click();
        await page.waitForTimeout(1000);
      } else if (headerButtons.length > 0) {
        // Just try the first header button if we couldn't identify a specific one
        logger.info('Trying first header button as potential info button');
        await headerButtons[0].click();
        await page.waitForTimeout(1000);
      } else {
        throw new Error('Could not find any buttons in chat header');
      }
    }
  } catch (error) {
    logger.error(
      'Error opening character info panel:',
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}
