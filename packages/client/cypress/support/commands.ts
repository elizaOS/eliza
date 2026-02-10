/// <reference types="cypress" />
/// <reference types="@testing-library/cypress" />

// Custom command to wait for the app to be ready
Cypress.Commands.add('waitForApp', () => {
  // Wait for the root element to exist
  cy.get('#root', { timeout: 30000 }).should('exist');

  // Wait for the app to be interactive
  cy.document().its('readyState').should('equal', 'complete');

  // Wait a bit for React to hydrate and render
  cy.wait(1000);

  // Check if there's any loading indicator and wait for it to disappear
  cy.get('body').then(($body) => {
    if ($body.find('[data-testid="loading"]').length > 0) {
      cy.get('[data-testid="loading"]', { timeout: 30000 }).should('not.exist');
    }
  });
});

// Custom command to login (can be implemented based on your auth flow)
Cypress.Commands.add('login', (email: string, password: string) => {
  // This is a placeholder - implement based on your auth system
  cy.visit('/login');
  cy.get('input[name="email"]').type(email);
  cy.get('input[name="password"]').type(password);
  cy.get('button[type="submit"]').click();

  // Wait for redirect or auth token
  cy.url().should('not.include', '/login');
});

// Custom command to connect to WebSocket
Cypress.Commands.add('connectWebSocket', () => {
  cy.window().then((win) => {
    // Wait for WebSocket connection to be established
    cy.wrap(null).then(() => {
      return new Cypress.Promise((resolve) => {
        const checkConnection = () => {
          // Check if socket exists on window or in your app state
          if ((win as any).socket?.connected) {
            resolve(undefined);
          } else {
            setTimeout(checkConnection, 100);
          }
        };
        checkConnection();
      });
    });
  });
});

// Custom command to clean up test data
Cypress.Commands.add('cleanupTestData', () => {
  // Clean up any test data created during tests
  cy.window().then((win) => {
    // Clear local storage
    win.localStorage.clear();

    // Clear session storage
    win.sessionStorage.clear();

    // Clear cookies
    cy.clearCookies();
  });
});

// Utility command to select by test id
Cypress.Commands.add('getByTestId', (testId: string) => {
  return cy.get(`[data-testid="${testId}"]`);
});

// Utility command to wait for API response
Cypress.Commands.add('waitForApi', (alias: string, timeout = 10000) => {
  return cy.wait(`@${alias}`, { timeout });
});

// Custom command to wait for the app navigation to be ready.
// Uses a single combined CSS selector so Cypress retries until any sidebar
// or navigation element appears, avoiding the fragile synchronous jQuery
// check pattern ($body.find(...)...) that caused flaky CI failures.
Cypress.Commands.add('waitForNavigation', (options: { timeout?: number } = {}) => {
  const timeout = options.timeout ?? 15000;

  // On desktop (1280x720) the sidebar renders as [data-testid="app-sidebar"].
  // On mobile viewports the mobile-menu-button is shown instead.
  // Some error/loading states may render a plain <aside>, <nav>, or [role="navigation"].
  // Combining them in one selector lets Cypress retry until ANY of them appear.
  cy.get(
    '[data-testid="app-sidebar"], [data-testid="mobile-menu-button"], aside, nav, [role="navigation"]',
    { timeout }
  ).should('exist');
});

// Custom command to wait for the app to be fully interactive after a page
// load or reload. Replaces the scattered cy.wait(500) / cy.wait(1000) calls
// with a deterministic check.
Cypress.Commands.add('waitForAppReady', () => {
  cy.get('#root', { timeout: 30000 }).should('exist');
  cy.document().its('readyState').should('equal', 'complete');

  // Check if there's a loading indicator and wait for it to disappear
  cy.get('body').then(($body) => {
    if ($body.find('[data-testid="loading"]').length > 0) {
      cy.get('[data-testid="loading"]', { timeout: 30000 }).should('not.exist');
    }
  });

  // Wait for React to finish hydration and at least one DOM element to render
  // beyond #root. This replaces arbitrary cy.wait() calls.
  cy.get('#root').children({ timeout: 10000 }).should('have.length.greaterThan', 0);
});

// Add TypeScript support for custom commands
declare global {
  namespace Cypress {
    interface Chainable {
      visitWithoutOnboarding(url?: string): Chainable<void>;
      waitForApp(): Chainable<void>;
      waitForAppReady(): Chainable<void>;
      waitForNavigation(options?: { timeout?: number }): Chainable<void>;
      login(email: string, password: string): Chainable<void>;
      connectWebSocket(): Chainable<void>;
      cleanupTestData(): Chainable<void>;
      getByTestId(testId: string): Chainable<JQuery<HTMLElement>>;
      waitForApi(alias: string, timeout?: number): Chainable<any>;
      setupApiMocks(): Chainable<void>;
      // Authentication commands from auth-commands.ts
      loginByApi(email: string, password: string): Chainable<void>;
      registerByApi(email: string, username: string, password: string): Chainable<void>;
    }
  }
}
