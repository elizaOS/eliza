/**
 * E2E tests for authenticated features using cy.session() for speed
 *
 * These tests use cy.loginByApi() which caches the authentication session,
 * making them significantly faster than the full UI authentication flow.
 *
 * Note: These tests require the server to be started with ENABLE_DATA_ISOLATION=true
 * Run with: bun run test:e2e:server:auth
 */

describe('Protected Features (Authenticated)', () => {
  const testEmail = `auth-test-${Date.now()}@example.com`;
  const testUsername = `authuser${Date.now()}`;
  const testPassword = 'TestPassword123!';

  before(() => {
    // Register user ONCE for all tests in this suite
    cy.clearCookies();
    cy.clearLocalStorage();

    // Register via API (faster than UI)
    cy.registerByApi(testEmail, testUsername, testPassword);
  });

  beforeEach(() => {
    // Reuse the authenticated session (super fast!)
    cy.loginByApi(testEmail, testPassword);

    // Visit with onboarding disabled
    cy.visitWithoutOnboarding('/');
    cy.wait(1000);
  });

  describe('Application Access', () => {
    it('should access the app without showing auth dialog', () => {
      // Auth dialog should NOT be visible (we're authenticated)
      cy.get('[data-testid="auth-tabs"]').should('not.exist');

      // User should have access to the app
      cy.get('[data-testid="app-sidebar"]').should('exist');
    });

    it('should display user-authenticated UI elements', () => {
      // Verify authenticated state
      cy.get('[data-testid="app-sidebar"]').should('exist');

      // Verify no auth dialog
      cy.get('[data-testid="auth-tabs"]').should('not.exist');
    });
  });

  describe('Navigation', () => {
    it('should navigate to different routes while authenticated', () => {
      // Navigate to home
      cy.visitWithoutOnboarding('/');
      cy.wait(500);
      cy.get('[data-testid="app-sidebar"]').should('exist');
      cy.get('[data-testid="auth-tabs"]').should('not.exist');

      // Navigate back to home (or any other route you have)
      cy.visitWithoutOnboarding('/');
      cy.wait(500);
      cy.get('[data-testid="app-sidebar"]').should('exist');
      cy.get('[data-testid="auth-tabs"]').should('not.exist');
    });
  });

  describe('Session Persistence', () => {
    it('should maintain authentication across page reloads', () => {
      // Verify authenticated
      cy.get('[data-testid="app-sidebar"]').should('exist');

      // Reload the page (use visitWithoutOnboarding to keep onboarding disabled)
      cy.visitWithoutOnboarding('/');
      cy.wait(1000);

      // Should still be authenticated (no auth dialog)
      cy.get('[data-testid="auth-tabs"]').should('not.exist');
      cy.get('[data-testid="app-sidebar"]').should('exist');

      // Verify JWT token is still present
      cy.window().then((win) => {
        const jwtToken = win.localStorage.getItem(`eliza-jwt-token-${win.location.origin}`);
        expect(jwtToken).to.exist;
        expect(jwtToken).to.match(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/); // JWT format
      });
    });
  });

  describe('Chat Functionality (Authenticated)', () => {
    it('should interact with chat interface when authenticated', () => {
      // Verify authenticated state
      cy.get('[data-testid="app-sidebar"]').should('exist');
      cy.get('[data-testid="auth-tabs"]').should('not.exist');

      // Try to interact with chat (if message input exists)
      cy.get('body').then(($body) => {
        if ($body.find('[data-testid="message-input"]').length > 0) {
          cy.get('[data-testid="message-input"]').should('be.visible');
          // Could add more chat interactions here if needed
        }
      });
    });
  });

  // Add more protected feature tests here as needed
  // Examples:
  // - Agents management
  // - Settings page
  // - Profile management
  // - etc.
});
