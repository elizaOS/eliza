/**
 * E2E tests for authentication (login, register, JWT token management)
 *
 * Note: These tests require the server to be started with ENABLE_DATA_ISOLATION=true
 * Run with: bun run test:e2e:server:auth
 */

describe('Authentication Flow', () => {
  const testEmail = `test-${Date.now()}@example.com`;
  const testUsername = `testuser${Date.now()}`;
  const testPassword = 'TestPassword123!';

  beforeEach(() => {
    // Clear cookies before each test
    cy.clearCookies();
    cy.clearLocalStorage();

    // Visit the home page with onboarding disabled
    cy.visitWithoutOnboarding('/');

    // Wait for app to load and auth dialog to appear (use assertion instead of fixed wait)
    cy.get('[data-testid="auth-tabs"]', { timeout: 15000 }).should('exist');
  });

  describe('User Registration', () => {
    it('should register a new user and receive JWT token', () => {
      // Auth dialog should be open automatically since requiresAuth is true
      cy.get('[data-testid="auth-tabs"]').should('exist');

      // Switch to register tab
      cy.get('[data-testid="register-tab"]').click();
      cy.wait(500);

      // Fill registration form
      cy.get('[data-testid="register-email-input"]').type(testEmail);
      cy.get('[data-testid="register-username-input"]').type(testUsername);
      cy.get('[data-testid="register-password-input"]').type(testPassword);
      cy.get('[data-testid="register-confirm-password-input"]').type(testPassword);

      // Submit form
      cy.get('[data-testid="register-submit-button"]').click();

      // Wait for registration to complete (dialog should close)
      cy.get('[data-testid="auth-tabs"]', { timeout: 10000 }).should('not.exist');

      // Verify JWT token is stored in localStorage
      cy.window().then((win) => {
        const jwtToken = win.localStorage.getItem(`eliza-jwt-token-${win.location.origin}`);
        expect(jwtToken).to.exist;
        expect(jwtToken).to.match(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/); // JWT format
      });

      // Verify user is authenticated (success toast should appear)
      cy.contains('Registration Successful').should('be.visible');
    });

    it('should reject registration with invalid email', () => {
      cy.get('[data-testid="register-tab"]').click();
      cy.wait(500);

      // Fill with invalid email
      cy.get('[data-testid="register-email-input"]').type('invalid-email');
      cy.get('[data-testid="register-username-input"]').type(testUsername);
      cy.get('[data-testid="register-password-input"]').type(testPassword);
      cy.get('[data-testid="register-confirm-password-input"]').type(testPassword);

      // Verify email field is invalid (HTML5 validation)
      cy.get('[data-testid="register-email-input"]').then(($input) => {
        const inputElement = $input[0] as HTMLInputElement;
        expect(inputElement.validity.valid).to.be.false;
      });

      // Try to submit form (will be blocked by browser validation)
      cy.get('[data-testid="register-submit-button"]').click();

      // Auth dialog should still be visible (form not submitted due to HTML5 validation)
      cy.get('[data-testid="auth-tabs"]').should('exist');

      // Verify JWT token is NOT stored
      cy.window().then((win) => {
        const jwtToken = win.localStorage.getItem(`eliza-jwt-token-${win.location.origin}`);
        expect(jwtToken).to.be.null;
      });
    });

    it('should reject registration with short password', () => {
      cy.get('[data-testid="register-tab"]').click();
      cy.wait(500);

      cy.get('[data-testid="register-email-input"]').type(testEmail);
      cy.get('[data-testid="register-username-input"]').type(testUsername);
      cy.get('[data-testid="register-password-input"]').type('short');
      cy.get('[data-testid="register-confirm-password-input"]').type('short');

      // Submit form
      cy.get('[data-testid="register-submit-button"]').click();

      // Verify registration failed: auth dialog should still be visible
      cy.get('[data-testid="auth-tabs"]', { timeout: 5000 }).should('exist');
    });

    it('should reject registration when passwords do not match', () => {
      cy.get('[data-testid="register-tab"]').click();
      cy.wait(500);

      cy.get('[data-testid="register-email-input"]').type(testEmail);
      cy.get('[data-testid="register-username-input"]').type(testUsername);
      cy.get('[data-testid="register-password-input"]').type(testPassword);
      cy.get('[data-testid="register-confirm-password-input"]').type('DifferentPassword123!');

      // Submit form
      cy.get('[data-testid="register-submit-button"]').click();

      // Verify registration failed: auth dialog should still be visible
      cy.get('[data-testid="auth-tabs"]', { timeout: 5000 }).should('exist');
    });
  });

  describe('User Login', () => {
    // First register a user to test login
    beforeEach(() => {
      const setupEmail = `setup-${Date.now()}@example.com`;
      const setupUsername = `setup${Date.now()}`;

      cy.get('[data-testid="register-tab"]').click();
      cy.wait(500);

      cy.get('[data-testid="register-email-input"]').type(setupEmail);
      cy.get('[data-testid="register-username-input"]').type(setupUsername);
      cy.get('[data-testid="register-password-input"]').type(testPassword);
      cy.get('[data-testid="register-confirm-password-input"]').type(testPassword);
      cy.get('[data-testid="register-submit-button"]').click();

      // Wait for registration to complete
      cy.get('[data-testid="auth-tabs"]', { timeout: 10000 }).should('not.exist');
      cy.wait(500);

      // Store credentials for login test
      cy.wrap(setupEmail).as('loginEmail');
      cy.wrap(setupUsername).as('loginUsername');

      // Logout (clear localStorage to test login)
      cy.clearLocalStorage();
      // Revisit with onboarding disabled (reload would show onboarding)
      cy.visitWithoutOnboarding('/');
      // Wait for auth dialog to appear
      cy.get('[data-testid="auth-tabs"]', { timeout: 15000 }).should('exist');
    });

    it('should login with valid credentials and receive JWT token', function () {
      // Auth dialog should be open, Login tab is default
      cy.get('[data-testid="login-tab"]').click();
      cy.wait(500);

      // Fill login form with registered credentials
      cy.get('[data-testid="login-email-input"]').type(this.loginEmail);
      cy.get('[data-testid="login-password-input"]').type(testPassword);

      // Submit form
      cy.get('[data-testid="login-submit-button"]').click();

      // Wait for login to complete (dialog should close)
      cy.get('[data-testid="auth-tabs"]', { timeout: 10000 }).should('not.exist');

      // Verify JWT token is stored
      cy.window().then((win) => {
        const jwtToken = win.localStorage.getItem(`eliza-jwt-token-${win.location.origin}`);
        expect(jwtToken).to.exist;
        expect(jwtToken).to.match(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/);
      });

      // Verify success toast
      cy.contains('Login Successful').should('be.visible');
    });

    it('should reject login with invalid credentials', function () {
      cy.get('[data-testid="login-tab"]').click();
      cy.wait(500);

      // Fill login form with wrong password
      cy.get('[data-testid="login-email-input"]').type(this.loginEmail);
      cy.get('[data-testid="login-password-input"]').type('WrongPassword123!');

      // Submit form
      cy.get('[data-testid="login-submit-button"]').click();

      // Verify error toast appears
      cy.contains('Login Failed', { timeout: 5000 }).should('be.visible');

      // Verify JWT token is NOT stored
      cy.window().then((win) => {
        const jwtToken = win.localStorage.getItem(`eliza-jwt-token-${win.location.origin}`);
        expect(jwtToken).to.be.null;
      });
    });

    it('should show password visibility toggle', () => {
      cy.get('[data-testid="login-tab"]').click();
      cy.wait(500);

      // Password field should be hidden by default
      cy.get('[data-testid="login-password-input"]').should('have.attr', 'type', 'password');

      // Click show password button
      cy.get('[data-testid="login-password-toggle"]').click();

      // Password should be visible
      cy.get('[data-testid="login-password-input"]').should('have.attr', 'type', 'text');

      // Click hide password button
      cy.get('[data-testid="login-password-toggle"]').click();

      // Password should be hidden again
      cy.get('[data-testid="login-password-input"]').should('have.attr', 'type', 'password');
    });
  });

  describe('Token Persistence', () => {
    it('should persist JWT token across page reloads', () => {
      // Use unique credentials for this test to avoid conflicts
      const persistenceEmail = `persistence-${Date.now()}@example.com`;
      const persistenceUsername = `persistence${Date.now()}`;

      // Register a user
      cy.get('[data-testid="register-tab"]').click();
      cy.wait(500);

      cy.get('[data-testid="register-email-input"]').type(persistenceEmail);
      cy.get('[data-testid="register-username-input"]').type(persistenceUsername);
      cy.get('[data-testid="register-password-input"]').type(testPassword);
      cy.get('[data-testid="register-confirm-password-input"]').type(testPassword);
      cy.get('[data-testid="register-submit-button"]').click();

      // Wait for registration
      cy.get('[data-testid="auth-tabs"]', { timeout: 10000 }).should('not.exist');
      cy.wait(1000);

      // Store the token
      let storedToken: string;
      cy.window().then((win) => {
        storedToken = win.localStorage.getItem(`eliza-jwt-token-${win.location.origin}`) || '';
        expect(storedToken).to.exist;
      });

      // Reload the page (use visitWithoutOnboarding to be consistent)
      cy.visitWithoutOnboarding('/');
      cy.wait(2000);

      // Verify token is still in localStorage
      cy.window().then((win) => {
        const jwtToken = win.localStorage.getItem(`eliza-jwt-token-${win.location.origin}`);
        expect(jwtToken).to.equal(storedToken);
      });

      // Auth dialog should NOT be open (user is authenticated)
      cy.get('[data-testid="auth-tabs"]').should('not.exist');
    });
  });

  describe('Protected Routes', () => {
    it('should open auth dialog when accessing app without token', () => {
      // Dialog should be open automatically since requiresAuth is true
      // and no token is present
      cy.get('[data-testid="auth-tabs"]').should('exist');
      cy.contains('Authentication').should('be.visible');
      cy.contains('Login to your account').should('be.visible');
    });

    it('should not show auth dialog when token is present', () => {
      // Use unique credentials for this test to avoid conflicts
      const protectedEmail = `protected-${Date.now()}@example.com`;
      const protectedUsername = `protected${Date.now()}`;

      // Register a user first
      cy.get('[data-testid="register-tab"]').click();
      cy.wait(500);

      cy.get('[data-testid="register-email-input"]').type(protectedEmail);
      cy.get('[data-testid="register-username-input"]').type(protectedUsername);
      cy.get('[data-testid="register-password-input"]').type(testPassword);
      cy.get('[data-testid="register-confirm-password-input"]').type(testPassword);
      cy.get('[data-testid="register-submit-button"]').click();

      // Wait for registration
      cy.get('[data-testid="auth-tabs"]', { timeout: 10000 }).should('not.exist');

      // Navigate around the app
      cy.visitWithoutOnboarding('/');
      cy.wait(1000);

      // Auth dialog should NOT reappear
      cy.get('[data-testid="auth-tabs"]').should('not.exist');

      // User should have access to the app
      cy.get('[data-testid="app-sidebar"]').should('exist');
    });
  });
});
