/**
 * E2E Tests for Complete User Workflows
 *
 * These tests simulate real user journeys through the application,
 * testing multiple features in sequence as a user would experience them.
 */

describe('Complete User Workflow E2E Tests', () => {
  describe('New User Onboarding', () => {
    it('should complete the full onboarding flow', () => {
      // Start at the home page
      cy.visit('/');

      // Check for welcome message or onboarding prompt
      cy.get('body').then(($body) => {
        if ($body.text().includes('Welcome') || $body.text().includes('Get Started')) {
          // Click get started if available
          cy.contains(/get started|start|begin/i)
            .first()
            .click();
        }
      });

      // Navigate to agents/chat
      cy.get('a[href*="agent"], button:contains("agent"), a[href*="chat"], button:contains("chat")')
        .first()
        .click({ force: true });

      // Wait for page to load
      cy.wait(1000);

      // Send first message
      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .type('Hello, I am a new user{enter}');

      // Wait for response
      cy.get('[data-testid*="message"], [class*="message"], [role="article"]', {
        timeout: 15000,
      }).should('have.length.greaterThan', 0);

      // Continue conversation
      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .type('What can you help me with?{enter}');

      // Verify we got another response
      cy.get('[data-testid*="message"], [class*="message"], [role="article"]', {
        timeout: 15000,
      }).should('have.length.greaterThan', 1);
    });
  });

  describe('Agent Configuration Workflow', () => {
    it('should configure and interact with an agent', () => {
      cy.visit('/');

      // Look for settings or configuration
      cy.get(
        'a[href*="settings"], button:contains("settings"), a[href*="config"], button:contains("config")'
      )
        .first()
        .then(($elem) => {
          if ($elem.length) {
            cy.wrap($elem).click({ force: true });

            // Look for agent configuration options
            cy.contains(/agent|model|personality/i).should('be.visible');

            // Navigate back to chat
            cy.get('a[href*="chat"], button:contains("chat")').first().click({ force: true });
          }
        });

      // Test agent with specific queries
      const queries = ['What is your name?', 'Tell me a joke', 'What is 2 + 2?'];

      queries.forEach((query, index) => {
        cy.get('input[type="text"], textarea, [contenteditable="true"]')
          .filter(':visible')
          .first()
          .type(`${query}{enter}`);

        // Wait for response before next query
        cy.wait(2000);

        // Verify response received
        cy.get('[data-testid*="message"], [class*="message"], [role="article"]').should(
          'have.length.greaterThan',
          index * 2
        );
      });
    });
  });

  describe('Multi-Session Workflow', () => {
    it('should maintain state across page refreshes', () => {
      cy.visit('/');

      // Navigate to chat
      cy.get('a[href*="chat"], a[href*="agent"], button:contains("chat"), button:contains("agent")')
        .first()
        .click({ force: true });

      // Send a message
      const testMessage = 'Remember this message for testing';
      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .type(`${testMessage}{enter}`);

      // Wait for response
      cy.wait(3000);

      // Refresh the page
      cy.reload();

      // Check if conversation history is maintained
      cy.contains(testMessage, { timeout: 10000 }).should('be.visible');
    });

    it('should handle multiple chat sessions', () => {
      cy.visit('/');

      // Create first chat session
      cy.get('a[href*="chat"], button:contains("chat")').first().click({ force: true });

      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .type('First session message{enter}');

      cy.wait(2000);

      // Look for new chat/session button
      cy.get('button')
        .filter(':contains("New"), :contains("new"), [aria-label*="new"]')
        .first()
        .then(($btn) => {
          if ($btn.length) {
            cy.wrap($btn).click();

            // Send message in new session
            cy.get('input[type="text"], textarea, [contenteditable="true"]')
              .filter(':visible')
              .first()
              .type('Second session message{enter}');

            // Verify messages are separate
            cy.contains('Second session message').should('be.visible');
            cy.contains('First session message').should('not.be.visible');
          }
        });
    });
  });

  describe('Error Recovery Workflow', () => {
    it('should recover from errors and continue working', () => {
      cy.visit('/');

      // Intercept network requests to simulate offline
      cy.intercept('*', { forceNetworkError: true }).as('offlineMode');

      // Try to send a message
      cy.get('a[href*="chat"], button:contains("chat")').first().click({ force: true });

      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .type('Offline message{enter}');

      // Should show error
      cy.contains(/offline|error|connection|failed/i, { timeout: 5000 }).should('be.visible');

      // Remove the offline intercept to go back online
      cy.intercept('*', (req) => {
        req.continue();
      }).as('onlineMode');

      // Retry sending
      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .type('Online message{enter}');

      // Should work now
      cy.contains('Online message', { timeout: 10000 }).should('be.visible');
    });
  });

  describe('Performance Workflow', () => {
    it('should handle rapid message sending', () => {
      cy.visit('/');

      cy.get('a[href*="chat"], button:contains("chat")').first().click({ force: true });

      // Send multiple messages rapidly
      for (let i = 0; i < 5; i++) {
        cy.get('input[type="text"], textarea, [contenteditable="true"]')
          .filter(':visible')
          .first()
          .type(`Rapid message ${i}{enter}`);

        // Very short delay
        cy.wait(100);
      }

      // All messages should be visible
      for (let i = 0; i < 5; i++) {
        cy.contains(`Rapid message ${i}`).should('be.visible');
      }

      // Should still be responsive
      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .should('not.be.disabled');
    });
  });
});

/**
 * WORKFLOW TESTING BEST PRACTICES
 *
 * 1. COMPLETE JOURNEYS
 *    - Test from start to finish
 *    - Include navigation between features
 *    - Verify state persistence
 *    - Test error recovery
 *
 * 2. REALISTIC SCENARIOS
 *    - New user experience
 *    - Power user workflows
 *    - Edge cases and errors
 *    - Performance under load
 *
 * 3. STATE MANAGEMENT
 *    - Test across refreshes
 *    - Multiple sessions
 *    - Browser back/forward
 *    - Local storage
 *
 * 4. INTEGRATION POINTS
 *    - API interactions
 *    - Real-time updates
 *    - Authentication flows
 *    - Data persistence
 *
 * WORKFLOW PATTERNS:
 * - Always start from a clean state
 * - Use realistic timing between actions
 * - Verify intermediate states
 * - Test both happy and error paths
 * - Consider mobile workflows
 */
