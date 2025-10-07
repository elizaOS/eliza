/**
 * E2E Tests for ElizaOS Dashboard
 *
 * These tests verify the full application flow from a user's perspective,
 * testing real interactions with the running application.
 */

describe('Dashboard E2E Tests', () => {
  beforeEach(() => {
    // Visit the dashboard before each test
    cy.visit('/');
  });

  describe('Dashboard Loading', () => {
    it('should load the dashboard successfully', () => {
      // Check that the page loads
      cy.url().should('include', 'localhost:3000');

      // Look for common dashboard elements
      cy.get('body').should('be.visible');

      // Check for any loading indicators
      cy.get('[data-testid="loading"]', { timeout: 5000 }).should('not.exist');
    });

    it('should display the application title or logo', () => {
      // Look for application branding
      cy.contains(/eliza|agent/i).should('be.visible');
    });

    it('should have proper meta tags', () => {
      // Check viewport meta tag
      cy.get('meta[name="viewport"]')
        .should('exist')
        .should('have.attr', 'content')
        .and('include', 'width=device-width');
    });
  });

  describe('Navigation', () => {
    it('should navigate to different sections', () => {
      // Look for navigation elements
      cy.get('nav, [role="navigation"], .navigation').should('exist');

      // Check for common navigation items
      const navItems = ['agents', 'chat', 'settings', 'docs'];
      navItems.forEach((item) => {
        cy.get(`a[href*="${item}"], button:contains("${item}")`, { timeout: 2000 }).should('exist');
      });
    });

    it('should handle navigation clicks', () => {
      // Click on a navigation item if it exists
      cy.get('a[href*="agents"], button:contains("agents")', { timeout: 2000 })
        .first()
        .click({ force: true });

      // Verify URL changed or content updated
      cy.url().should('match', /agents|agent/i);
    });
  });

  describe('Responsive Design', () => {
    it('should be responsive on mobile', () => {
      // Test mobile viewport
      cy.viewport(375, 667);
      cy.wait(500);

      // Check that content is still visible
      cy.get('body').should('be.visible');

      // Mobile menu might be hidden
      cy.get('nav, [role="navigation"]').then(($nav) => {
        if ($nav.is(':visible')) {
          expect($nav).to.be.visible;
        } else {
          // Look for mobile menu button
          cy.get('[aria-label*="menu"], button[class*="menu"]').should('be.visible');
        }
      });
    });

    it('should be responsive on tablet', () => {
      // Test tablet viewport
      cy.viewport(768, 1024);
      cy.wait(500);

      cy.get('body').should('be.visible');
    });
  });

  describe('Error Handling', () => {
    it('should handle 404 pages gracefully', () => {
      cy.visit('/non-existent-page', { failOnStatusCode: false });

      // Should show some error message or redirect
      cy.contains(/404|not found|error/i, { timeout: 5000 }).should('be.visible');
    });

    it('should handle network errors', () => {
      // Intercept and force a network error
      cy.intercept('GET', '/api/**', { forceNetworkError: true }).as('networkError');

      cy.visit('/');

      // Should handle the error gracefully
      cy.get('body').should('be.visible');
    });
  });
});

/**
 * E2E TESTING PATTERNS FOR ELIZAOS
 *
 * 1. REAL APPLICATION TESTING
 *    - Test against the running application
 *    - No mocking unless testing error scenarios
 *    - Verify actual user workflows
 *
 * 2. PAGE NAVIGATION
 *    - Test all navigation paths
 *    - Verify URL changes
 *    - Check for proper redirects
 *
 * 3. RESPONSIVE TESTING
 *    - Test multiple viewport sizes
 *    - Verify mobile menu behavior
 *    - Check touch interactions
 *
 * 4. PERFORMANCE
 *    - Set reasonable timeouts
 *    - Check for loading indicators
 *    - Verify async operations complete
 *
 * 5. ERROR SCENARIOS
 *    - Test 404 pages
 *    - Network failures
 *    - API errors
 *    - Form validation
 *
 * BEST PRACTICES:
 * - Use data-testid attributes for reliable selection
 * - Avoid brittle selectors based on classes
 * - Test user-visible behavior, not implementation
 * - Keep tests independent and idempotent
 */
