describe('Home Page', () => {
  beforeEach(() => {
    // Visit the home page before each test
    cy.visit('/');
    
    // Wait for app to be ready (inline implementation)
    cy.get('#root', { timeout: 30000 }).should('exist');
    cy.document().its('readyState').should('equal', 'complete');
    cy.wait(1000);
    
    // Check if there's any loading indicator and wait for it to disappear
    cy.get('body').then(($body) => {
      if ($body.find('[data-testid="loading"]').length > 0) {
        cy.get('[data-testid="loading"]', { timeout: 30000 }).should('not.exist');
      }
    });
  });

  it('loads successfully', () => {
    // Check that the page loads
    cy.url().should('eq', `${Cypress.config('baseUrl')}/`);
    
    // Check for root element
    cy.get('#root').should('exist');
  });

  it('displays the main navigation', () => {
    // Check for sidebar
    cy.get('[data-testid="app-sidebar"]').should('exist');
    
    // Check for main navigation items
    cy.contains('Agents').should('be.visible');
    cy.contains('Home').should('be.visible');
  });

  it('displays the agent list', () => {
    // Check for agent cards
    cy.get('[data-testid="agent-card"]').should('exist');
    
    // Check for add agent button
    cy.get('[data-testid="add-agent-button"]').should('exist');
  });

  it('can navigate to agent creation', () => {
    // Click on add agent button
    cy.get('[data-testid="add-agent-button"]').click();
    
    // Should navigate to create agent page
    cy.url().should('include', '/agent/new');
    
    // Check for form elements
    cy.get('form').should('exist');
    cy.get('input[name="name"]').should('exist');
  });

  it('can navigate to an agent detail page', () => {
    // Click on first agent card
    cy.get('[data-testid="agent-card"]').first().click();
    
    // Should navigate to agent detail page
    cy.url().should('match', /\/agent\/[a-zA-Z0-9-]+$/);
    
    // Check for agent details
    cy.get('[data-testid="agent-details"]').should('exist');
  });

  it('can toggle sidebar', () => {
    // Find sidebar toggle button
    cy.get('[data-testid="sidebar-toggle"]').click();
    
    // Sidebar should be collapsed
    cy.get('[data-testid="app-sidebar"]').should('have.attr', 'data-collapsed', 'true');
    
    // Click again to expand
    cy.get('[data-testid="sidebar-toggle"]').click();
    
    // Sidebar should be expanded
    cy.get('[data-testid="app-sidebar"]').should('have.attr', 'data-collapsed', 'false');
  });

  it('displays connection status', () => {
    // Check for connection status indicator
    cy.get('[data-testid="connection-status"]').should('exist');
    
    // Should show connected or connecting
    cy.get('[data-testid="connection-status"]')
      .should('contain.text', /Connected|Connecting/i);
  });

  it('handles responsive design', () => {
    // Test mobile viewport
    cy.viewport('iphone-x');
    
    // Sidebar should be hidden on mobile
    cy.get('[data-testid="app-sidebar"]').should('not.be.visible');
    
    // Mobile menu button should be visible
    cy.get('[data-testid="mobile-menu-button"]').should('be.visible');
    
    // Click mobile menu button
    cy.get('[data-testid="mobile-menu-button"]').click();
    
    // Sidebar should now be visible
    cy.get('[data-testid="app-sidebar"]').should('be.visible');
    
    // Reset viewport
    cy.viewport(1280, 720);
  });

  it('shows loading states properly', () => {
    // Intercept API calls to simulate loading
    cy.intercept('GET', '/api/agents', {
      delay: 1000,
      body: { agents: [] }
    }).as('getAgents');
    
    // Reload page
    cy.reload();
    
    // Should show loading indicator
    cy.get('[data-testid="loading"]').should('exist');
    
    // Wait for request to complete
    cy.wait('@getAgents');
    
    // Loading indicator should disappear
    cy.get('[data-testid="loading"]').should('not.exist');
  });

  it('handles errors gracefully', () => {
    // Intercept API calls to simulate error
    cy.intercept('GET', '/api/agents', {
      statusCode: 500,
      body: { error: 'Server error' }
    }).as('getAgentsError');
    
    // Reload page
    cy.reload();
    
    // Wait for error
    cy.wait('@getAgentsError');
    
    // Should show error message
    cy.contains('error', { matchCase: false }).should('be.visible');
  });
}); 