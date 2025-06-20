/**
 * E2E Tests for Agent Chat Functionality
 *
 * These tests verify the chat interface and agent interactions
 * in the running application.
 */

describe('Agent Chat E2E Tests', () => {
  beforeEach(() => {
    // Visit the dashboard
    cy.visit('/');

    // Navigate to chat or agents section
    cy.get('a[href*="chat"], a[href*="agent"], button:contains("chat"), button:contains("agent")', {
      timeout: 5000,
    })
      .first()
      .click({ force: true });
  });

  describe('Chat Interface', () => {
    it('should display the chat interface', () => {
      // Look for chat-related elements
      cy.get('[data-testid="chat-container"], .chat-container, #chat, [role="main"]').should(
        'be.visible'
      );
    });

    it('should have a message input field', () => {
      // Look for input field
      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .should('be.visible')
        .should('not.be.disabled');
    });

    it('should have a send button', () => {
      // Look for send button
      cy.get('button')
        .filter(':contains("Send"), :contains("send"), [aria-label*="send"]')
        .should('be.visible')
        .should('not.be.disabled');
    });
  });

  describe('Sending Messages', () => {
    it('should send a message when typing and clicking send', () => {
      const testMessage = 'Hello, this is a test message';

      // Type message
      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .type(testMessage);

      // Click send
      cy.get('button')
        .filter(':contains("Send"), :contains("send"), [aria-label*="send"]')
        .first()
        .click();

      // Verify message appears in chat
      cy.contains(testMessage, { timeout: 10000 }).should('be.visible');
    });

    it('should send a message when pressing Enter', () => {
      const testMessage = 'Test message with Enter key';

      // Type message and press Enter
      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .type(`${testMessage}{enter}`);

      // Verify message appears
      cy.contains(testMessage, { timeout: 10000 }).should('be.visible');
    });

    it('should clear input after sending', () => {
      const testMessage = 'Message to clear';

      // Get input element
      const input = cy
        .get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first();

      // Type and send
      input.type(testMessage);

      cy.get('button')
        .filter(':contains("Send"), :contains("send"), [aria-label*="send"]')
        .first()
        .click();

      // Verify input is cleared
      input.should('have.value', '');
    });
  });

  describe('Agent Responses', () => {
    it('should receive a response from the agent', () => {
      // Send a simple message
      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .type('Hello agent{enter}');

      // Wait for agent response
      // Look for typical agent response indicators
      cy.get('[data-testid*="agent"], [class*="agent"], [role="article"]', {
        timeout: 15000,
      }).should('have.length.greaterThan', 0);
    });

    it('should show typing indicator while agent is responding', () => {
      // Send message
      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .type('Tell me about yourself{enter}');

      // Look for typing indicator
      cy.get('[data-testid="typing"], [class*="typing"], [aria-label*="typing"]', {
        timeout: 5000,
      }).should('be.visible');

      // Typing indicator should disappear after response
      cy.get('[data-testid="typing"], [class*="typing"], [aria-label*="typing"]', {
        timeout: 15000,
      }).should('not.exist');
    });
  });

  describe('Chat History', () => {
    it('should maintain chat history', () => {
      const messages = ['First message', 'Second message', 'Third message'];

      // Send multiple messages
      messages.forEach((msg, index) => {
        cy.get('input[type="text"], textarea, [contenteditable="true"]')
          .filter(':visible')
          .first()
          .type(`${msg}{enter}`);

        // Wait a bit between messages
        cy.wait(1000);
      });

      // Verify all messages are visible
      messages.forEach((msg) => {
        cy.contains(msg).should('be.visible');
      });
    });

    it('should scroll to latest message', () => {
      // Send multiple messages to create scroll
      for (let i = 0; i < 10; i++) {
        cy.get('input[type="text"], textarea, [contenteditable="true"]')
          .filter(':visible')
          .first()
          .type(`Message number ${i}{enter}`);
        cy.wait(500);
      }

      // Check that the latest message is in view
      cy.contains('Message number 9').should('be.visible');
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', () => {
      // Intercept API calls and force error
      cy.intercept('POST', '**/api/chat/**', {
        statusCode: 500,
        body: { error: 'Server error' },
      }).as('chatError');

      // Send message
      cy.get('input[type="text"], textarea, [contenteditable="true"]')
        .filter(':visible')
        .first()
        .type('This will fail{enter}');

      // Should show error message
      cy.contains(/error|failed|try again/i, { timeout: 10000 }).should('be.visible');
    });

    it('should prevent sending empty messages', () => {
      // Try to send empty message
      cy.get('button')
        .filter(':contains("Send"), :contains("send"), [aria-label*="send"]')
        .first()
        .click();

      // Should not create any new message elements
      cy.get('[data-testid*="message"], [class*="message"]').should('have.length', 0);
    });
  });
});

/**
 * CHAT TESTING PATTERNS
 *
 * 1. MESSAGE FLOW
 *    - Test sending messages
 *    - Verify message display
 *    - Check input clearing
 *    - Test keyboard shortcuts
 *
 * 2. AGENT INTERACTION
 *    - Wait for responses
 *    - Check typing indicators
 *    - Verify response format
 *    - Test conversation context
 *
 * 3. UI BEHAVIOR
 *    - Auto-scroll to latest
 *    - Maintain history
 *    - Handle long messages
 *    - Responsive layout
 *
 * 4. ERROR CASES
 *    - Network failures
 *    - Empty messages
 *    - Rate limiting
 *    - Session timeouts
 *
 * TIPS:
 * - Use generous timeouts for agent responses
 * - Test real-world scenarios
 * - Verify accessibility features
 * - Check mobile interactions
 */
