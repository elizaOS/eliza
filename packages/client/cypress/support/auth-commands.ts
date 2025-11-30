/**
 * Custom Cypress commands for authentication
 * Uses cy.session() to cache authentication state and speed up tests
 *
 * TypeScript declarations are in commands.ts
 */

/**
 * Initialize authentication commands
 * Must be called explicitly to register commands (prevents tree-shaking issues)
 */
export function registerAuthCommands() {
  /**
   * Register a new user via API and cache the session
   * Uses cy.session() to avoid re-registering in every test
   */
  Cypress.Commands.add('registerByApi', (email: string, username: string, password: string) => {
  cy.session(
    ['register', email],
    () => {
      cy.request({
        method: 'POST',
        url: '/api/auth/register',
        body: { email, username, password },
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(201);
        expect(resp.body.success).to.be.true;
        expect(resp.body.data).to.exist;
        expect(resp.body.data.token).to.exist;

        const token = resp.body.data.token;
        const origin = Cypress.config().baseUrl || window.location.origin;

        // Store JWT token in localStorage (same way the app does it)
        window.localStorage.setItem(`eliza-jwt-token-${origin}`, token);
      });
    },
    {
      validate() {
        // Validate that the session is still valid
        const origin = Cypress.config().baseUrl || window.location.origin;
        const token = window.localStorage.getItem(`eliza-jwt-token-${origin}`);
        expect(token).to.exist;
        expect(token).to.match(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/); // JWT format
      },
    }
  );
  });

  /**
   * Login via API and cache the session
   * Uses cy.session() to avoid re-logging in every test
   */
  Cypress.Commands.add('loginByApi', (email: string, password: string) => {
    cy.session(
      ['login', email],
      () => {
        cy.request({
          method: 'POST',
          url: '/api/auth/login',
          body: { email, password },
          failOnStatusCode: true,
        }).then((resp) => {
          expect(resp.status).to.eq(200);
          expect(resp.body.success).to.be.true;
          expect(resp.body.data).to.exist;
          expect(resp.body.data.token).to.exist;

          const token = resp.body.data.token;
          const origin = Cypress.config().baseUrl || window.location.origin;

          // Store JWT token in localStorage (same way the app does it)
          window.localStorage.setItem(`eliza-jwt-token-${origin}`, token);
        });
      },
      {
        validate() {
          // Validate that the session is still valid
          const origin = Cypress.config().baseUrl || window.location.origin;
          const token = window.localStorage.getItem(`eliza-jwt-token-${origin}`);
          expect(token).to.exist;
          expect(token).to.match(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/); // JWT format
        },
      }
    );
  });
}
