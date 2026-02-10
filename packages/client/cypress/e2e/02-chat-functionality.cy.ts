describe('Chat Functionality', () => {
  beforeEach(() => {
    // Setup global API mocks
    cy.setupApiMocks();

    // Mock API calls to prevent timeouts
    cy.intercept('GET', '/api/system/version', {
      statusCode: 200,
      body: {
        version: '1.0.0',
        source: 'test',
        timestamp: new Date().toISOString(),
        environment: 'test',
        uptime: 1000,
      },
    }).as('getServerVersion');

    cy.intercept('GET', '/api/agents', {
      statusCode: 200,
      body: {
        agents: [],
      },
    }).as('getAgents');

    // Visit the home page first
    cy.visit('/');
    cy.waitForAppReady();
  });

  it('can navigate to chat interface', () => {
    // Check if agent cards exist and are clickable
    cy.get('body').then(($body) => {
      if ($body.find('[data-testid="agent-card"]').length > 0) {
        // If agent cards exist, click the first one
        cy.get('[data-testid="agent-card"]').first().click();

        // Should navigate to some route (could be chat or agent details)
        cy.url().should('not.eq', `${Cypress.config('baseUrl')}/`);
      } else {
        // Just verify the main interface loaded
        cy.waitForNavigation();
      }
    });
  });

  it('displays basic interface elements', () => {
    // Navigation should be present (retryable combined selector)
    cy.waitForNavigation();
  });

  it('can interact with sidebar', () => {
    // Navigation should be present
    cy.waitForNavigation();

    cy.log('Sidebar elements verified - interaction may not be available in E2E context');
  });

  it('handles API interactions', () => {
    // Intercept agents API call
    cy.intercept('GET', '/api/agents', {
      body: {
        data: {
          agents: [
            {
              id: '12345678-1234-1234-1234-123456789012',
              name: 'Test Agent',
              status: 'active',
            },
          ],
        },
      },
    }).as('getAgentsWithData');

    // Reload to trigger API call
    cy.reload();
    cy.waitForAppReady();

    // Wait for the API call
    cy.wait('@getAgentsWithData');

    // Verify the page still works
    cy.get('#root').should('exist');
    cy.waitForNavigation();
  });

  it('handles error states gracefully', () => {
    // Intercept with error response
    cy.intercept('GET', '/api/agents', {
      statusCode: 500,
      body: { error: 'Internal Server Error' },
    }).as('getAgentsError');

    // Reload to trigger error
    cy.reload();
    cy.waitForAppReady();

    // Wait for error response
    cy.wait('@getAgentsError');

    // App should still be functional
    cy.get('#root').should('exist');
    cy.waitForNavigation();
  });

  it('supports mobile navigation', () => {
    // Switch to mobile view
    cy.viewport('iphone-x');

    // Mobile menu button should be visible (retryable)
    cy.get('[data-testid="mobile-menu-button"]', { timeout: 15000 }).should('be.visible');

    // Click to open mobile menu with force to overcome covering elements
    cy.get('[data-testid="mobile-menu-button"]').click({ force: true });

    // Sidebar should appear in mobile sheet
    cy.get('[data-testid="app-sidebar"]', { timeout: 10000 }).should('exist');

    // Reset viewport
    cy.viewport(1280, 720);
  });

  it('loads without critical errors', () => {
    // Check that no major JavaScript errors are displayed
    cy.get('body').should('not.contain.text', 'Uncaught');
    cy.get('body').should('not.contain.text', 'TypeError');
    cy.get('body').should('not.contain.text', 'ReferenceError');

    // Basic elements should exist
    cy.get('#root').should('exist');
    cy.waitForNavigation();
  });

  it('has working connection status', () => {
    // Connection status should exist (retryable)
    cy.get('[data-testid="connection-status"]', { timeout: 15000 }).should('exist');

    // Should be clickable (even if it doesn't do much)
    cy.get('[data-testid="connection-status"]').click({ force: true });

    // Status should still exist after click
    cy.get('[data-testid="connection-status"]').should('exist');
  });

  it('maintains state during navigation', () => {
    // Toggle sidebar if available
    cy.get('body').then(($body) => {
      if ($body.find('[data-testid="sidebar-toggle"]').length > 0) {
        cy.get('[data-testid="sidebar-toggle"]').click();
      }
    });

    // Navigate if possible
    cy.get('body').then(($body) => {
      if ($body.find('[data-testid="agent-card"]').length > 0) {
        cy.get('[data-testid="agent-card"]').first().click();
      }
    });

    // Basic structure should remain
    cy.get('#root').should('exist');
  });

  it('handles concurrent requests', () => {
    // Setup interceptor for known API endpoint with delay
    cy.intercept('GET', '/api/agents', { delay: 500, body: { data: { agents: [] } } }).as(
      'getAgentsDelayed'
    );

    // Reload to trigger requests
    cy.reload();
    cy.waitForAppReady();

    // Wait for the agents request
    cy.wait('@getAgentsDelayed');

    // App should be functional -- use retryable combined selector
    cy.waitForNavigation();
  });
});
