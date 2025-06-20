/**
 * E2E Support File
 *
 * This file is loaded automatically before E2E test files.
 * Use it to set up global configuration and custom commands.
 */

// ***********************************************************
// This file is processed and loaded automatically before your test files.
// You can change the location of this file or turn off processing using the
// 'supportFile' config option.
// ***********************************************************

// Import commands (shared with component tests)
import './commands';

// Import Testing Library Cypress commands
import '@testing-library/cypress/add-commands';

// E2E-specific configurations
Cypress.on('uncaught:exception', (err, runnable) => {
  // Prevent Cypress from failing the test on uncaught exceptions
  // This is useful for E2E tests where third-party scripts might throw errors
  console.error('Uncaught exception:', err);
  return false;
});

// Custom E2E commands
declare global {
  namespace Cypress {
    interface Chainable {
      /**
       * Login to the application
       * @param username - Username to login with
       * @param password - Password to login with
       */
      login(username?: string, password?: string): Chainable<void>;

      /**
       * Wait for the application to be ready
       */
      waitForApp(): Chainable<void>;

      /**
       * Navigate to a specific agent chat
       * @param agentId - ID of the agent to chat with
       */
      navigateToAgent(agentId?: string): Chainable<void>;

      /**
       * Send a chat message and wait for response
       * @param message - Message to send
       */
      sendChatMessage(message: string): Chainable<void>;

      /**
       * Clear all application data
       */
      clearAppData(): Chainable<void>;
    }
  }
}

// Login command
Cypress.Commands.add('login', (username = 'testuser', password = 'testpass') => {
  // Check if login is required
  cy.get('body').then(($body) => {
    if ($body.find('[data-testid="login"], form[name="login"], input[name="username"]').length) {
      cy.get('input[name="username"], input[type="email"]').first().type(username);
      cy.get('input[name="password"], input[type="password"]').first().type(password);
      cy.get('button[type="submit"], button:contains("Login")').first().click();
      cy.wait(1000);
    }
  });
});

// Wait for app to be ready
Cypress.Commands.add('waitForApp', () => {
  // Wait for any loading indicators to disappear
  cy.get('[data-testid="loading"], .loading, .spinner', { timeout: 10000 }).should('not.exist');

  // Ensure the app container is visible
  cy.get('#root, #app, [data-testid="app"]').should('be.visible');

  // Wait a bit for any animations
  cy.wait(500);
});

// Navigate to agent
Cypress.Commands.add('navigateToAgent', (agentId?: string) => {
  if (agentId) {
    cy.visit(`/agent/${agentId}`);
  } else {
    cy.get('a[href*="agent"], button:contains("agent")').first().click({ force: true });
  }
  cy.waitForApp();
});

// Send chat message
Cypress.Commands.add('sendChatMessage', (message: string) => {
  // Find and type in the input
  cy.get('input[type="text"], textarea, [contenteditable="true"]')
    .filter(':visible')
    .first()
    .clear()
    .type(message);

  // Send the message
  cy.get('button').filter(':contains("Send"), [aria-label*="send"]').first().click();

  // Wait for the message to appear
  cy.contains(message, { timeout: 5000 }).should('be.visible');

  // Wait for agent response
  cy.get('[data-testid*="agent"], [class*="agent"], [data-sender="agent"]', {
    timeout: 15000,
  }).should('exist');
});

// Clear app data
Cypress.Commands.add('clearAppData', () => {
  cy.window().then((win) => {
    // Clear local storage
    (win as any).localStorage.clear();

    // Clear session storage
    (win as any).sessionStorage.clear();

    // Clear cookies
    cy.clearCookies();

    // Note: IndexedDB clearing is commented out due to TypeScript compatibility issues
    // If your app uses IndexedDB, you may need to add custom clearing logic here
    // Example:
    // cy.window().its('indexedDB').invoke('deleteDatabase', 'your-db-name');
  });
});

// E2E-specific viewport settings
beforeEach(() => {
  // Set a consistent viewport for E2E tests
  cy.viewport(1280, 720);
});

// Screenshot on failure
Cypress.on('fail', (error, runnable) => {
  // Take a screenshot when a test fails
  cy.screenshot(`failed-${runnable.parent?.title}-${runnable.title}`, {
    capture: 'runner',
  });
  throw error;
});

/**
 * E2E TESTING UTILITIES
 *
 * These commands help with common E2E testing scenarios:
 *
 * 1. LOGIN FLOWS
 *    - cy.login() - Handle authentication
 *    - Supports different auth methods
 *
 * 2. NAVIGATION
 *    - cy.navigateToAgent() - Go to agent chat
 *    - cy.waitForApp() - Wait for app ready
 *
 * 3. INTERACTIONS
 *    - cy.sendChatMessage() - Send and verify messages
 *    - Handles async responses
 *
 * 4. STATE MANAGEMENT
 *    - cy.clearAppData() - Reset application state
 *    - Clears all storage types
 *
 * BEST PRACTICES:
 * - Use these commands for consistency
 * - Add new commands as patterns emerge
 * - Keep commands focused and reusable
 */
