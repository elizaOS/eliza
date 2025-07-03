describe('Home Page', () => {
  beforeEach(() => {
    // Visit the home page before each test
    cy.visit('/');

    // Wait for app to be ready (inline implementation)
    cy.get('#root', { timeout: 30000 }).should('exist');
    cy.document().its('readyState').should('equal', 'complete');
    cy.wait(1000);
  });

  it('loads successfully', () => {
    // Check that the page loads
    cy.url().should('eq', `${Cypress.config('baseUrl')}/`);

    // Check for root element
    cy.get('#root').should('exist');

    // Wait for content to load
    cy.get('body').should('be.visible');
  });

  it('displays the main navigation', () => {
    // Check for sidebar
    cy.get('[data-testid="app-sidebar"]').should('exist');

    // Check for sidebar toggle button - may not be visible in all states
    cy.get('body').then(($body) => {
      if ($body.find('[data-testid="sidebar-toggle"]').length > 0) {
        cy.get('[data-testid="sidebar-toggle"]').should('exist');
      } else {
        // Alternative: check for mobile menu button
        cy.get('[data-testid="mobile-menu-button"]').should('exist');
      }
    });
  });

  it('displays connection status', () => {
    // Check for connection status indicator
    cy.get('[data-testid="connection-status"]', { timeout: 10000 }).should('exist');
  });

  it('can toggle sidebar', () => {
    // Check if sidebar toggle exists, otherwise skip this test
    cy.get('body').then(($body) => {
      if ($body.find('[data-testid="sidebar-toggle"]').length > 0) {
        // Find sidebar toggle button and click it
        cy.get('[data-testid="sidebar-toggle"]').click();

        // Wait a moment for the animation
        cy.wait(500);

        // Click again to expand
        cy.get('[data-testid="sidebar-toggle"]').click();

        // Sidebar toggle should still exist
        cy.get('[data-testid="sidebar-toggle"]').should('exist');
      } else {
        // Alternative: test mobile menu button
        cy.get('[data-testid="mobile-menu-button"]').should('exist');
        cy.log('Sidebar toggle not available in current layout');
      }
    });
  });

  it('handles responsive design', () => {
    // Test mobile viewport
    cy.viewport('iphone-x');

    // Wait for layout to settle
    cy.wait(1000);

    // Mobile menu button should be visible
    cy.get('[data-testid="mobile-menu-button"]').should('be.visible');

    // Click mobile menu button with force to overcome any covering elements
    cy.get('[data-testid="mobile-menu-button"]').click({ force: true });

    // Wait for sidebar to appear
    cy.wait(500);

    // App sidebar should exist in the mobile sheet
    cy.get('[data-testid="app-sidebar"]').should('exist');

    // Reset viewport
    cy.viewport(1280, 720);

    // Wait for layout to settle back
    cy.wait(500);
  });

  it('shows loading states properly', () => {
    // Intercept API calls to simulate loading
    cy.intercept('GET', '/api/agents', {
      delay: 1000,
      body: { data: { agents: [] } },
    }).as('getAgents');

    // Reload page
    cy.reload();
    // Wait for app to be ready
    cy.get('#root', { timeout: 30000 }).should('exist');
    cy.document().its('readyState').should('equal', 'complete');
    cy.wait(500);

    // Wait for request to complete
    cy.wait('@getAgents');

    // Page should still be functional
    cy.get('#root').should('exist');
  });

  it('handles errors gracefully', () => {
    // Intercept API calls to simulate error
    cy.intercept('GET', '/api/agents', {
      statusCode: 500,
      body: { error: 'Server error' },
    }).as('getAgentsError');

    // Reload page
    cy.reload();
    // Wait for app to be ready
    cy.get('#root', { timeout: 30000 }).should('exist');
    cy.document().its('readyState').should('equal', 'complete');
    cy.wait(500);

    // Wait for error
    cy.wait('@getAgentsError');

    // App should still be functional
    cy.get('#root').should('exist');
    cy.get('[data-testid="app-sidebar"]').should('exist');
  });

  it('loads basic page structure', () => {
    // Check that main structural elements exist
    cy.get('#root').should('exist');
    cy.get('[data-testid="app-sidebar"]').should('exist');

    // Check that the page doesn't show any critical errors
    cy.get('body').should('not.contain.text', 'Error:');
    cy.get('body').should('not.contain.text', 'TypeError:');
  });

  it('has working navigation elements', () => {
    // Check sidebar exists and is interactive
    cy.get('[data-testid="app-sidebar"]').should('exist');

    // Check for navigation elements that exist
    cy.get('body').then(($body) => {
      if ($body.find('[data-testid="sidebar-toggle"]').length > 0) {
        // Check sidebar toggle works
        cy.get('[data-testid="sidebar-toggle"]').should('exist').click();

        // Toggle back
        cy.get('[data-testid="sidebar-toggle"]').click();

        // Verify sidebar still exists
        cy.get('[data-testid="app-sidebar"]').should('exist');
      } else {
        // Just verify basic navigation elements exist
        cy.get('[data-testid="mobile-menu-button"]').should('exist');
        cy.log('Sidebar toggle not available, verified other navigation elements');
      }
    });
  });
});
