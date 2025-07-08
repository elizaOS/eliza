describe('SPA Routing', () => {
  // Use actual routes from App.tsx
  const routes = [
    { path: '/create', name: 'Create Agent' },
    { path: '/settings/', name: 'Settings' },
    { path: '/logs', name: 'System Logs' },
    { path: '/agents/new', name: 'New Agent' },
    { path: '/group/new', name: 'New Group' },
  ];

  beforeEach(() => {
    // Start from home page
    cy.visit('/');

    // Wait for app to be ready
    cy.get('#root', { timeout: 30000 }).should('exist');
    cy.document().its('readyState').should('equal', 'complete');
    cy.wait(1000);
  });

  it('navigates to different routes without refresh', () => {
    // Test navigation through UI elements
    routes.forEach((route) => {
      // Navigate to route programmatically
      cy.window().then((win) => {
        win.history.pushState({}, '', route.path);
        win.dispatchEvent(new Event('popstate'));
      });

      // Wait for route change
      cy.wait(500);

      // Verify URL changed
      cy.url().should('include', route.path);

      // Verify app is still loaded (no full page refresh)
      cy.get('#root').should('exist');
    });
  });

  it('handles direct navigation to routes', () => {
    routes.forEach((route) => {
      // Visit route directly
      cy.visit(route.path);

      // Wait for app to load
      cy.get('#root', { timeout: 30000 }).should('exist');
      cy.document().its('readyState').should('equal', 'complete');

      // Verify URL is correct
      cy.url().should('include', route.path);

      // Verify no error messages
      cy.get('body').should('not.contain.text', 'Not Found');
      cy.get('body').should('not.contain.text', '404');
      cy.get('body').should('not.contain.text', 'Client application not found');
    });
  });

  it('handles page refresh on non-home routes', () => {
    routes.forEach((route) => {
      // Navigate to route first
      cy.visit(route.path);

      // Wait for initial load
      cy.get('#root', { timeout: 30000 }).should('exist');
      cy.wait(1000);

      // Refresh the page
      cy.reload();

      // Wait for app to reload
      cy.get('#root', { timeout: 30000 }).should('exist');
      cy.document().its('readyState').should('equal', 'complete');

      // Verify we're still on the same route
      cy.url().should('include', route.path);

      // Verify app loaded correctly
      cy.get('body').should('not.contain.text', 'Not Found');
      cy.get('body').should('not.contain.text', '404');
      cy.get('body').should('not.contain.text', 'Client application not found');

      // Verify the app sidebar still exists
      cy.get('[data-testid="app-sidebar"]').should('exist');
    });
  });

  it('handles browser back/forward navigation', () => {
    // Navigate through multiple routes
    const navigationPath = ['/create', '/settings/', '/logs'];

    navigationPath.forEach((path) => {
      cy.visit(path);
      cy.get('#root', { timeout: 30000 }).should('exist');
      cy.wait(500);
    });

    // Go back twice
    cy.go('back');
    cy.wait(500);
    cy.url().should('include', '/settings/');

    cy.go('back');
    cy.wait(500);
    cy.url().should('include', '/create');

    // Go forward
    cy.go('forward');
    cy.wait(500);
    cy.url().should('include', '/settings/');

    // Verify app is still functional
    cy.get('#root').should('exist');
    cy.get('[data-testid="app-sidebar"]').should('exist');
  });

  it('handles deep links with query parameters', () => {
    const deepLinks = [
      '/create?template=basic',
      '/settings/?tab=preferences',
      '/logs?filter=error',
    ];

    deepLinks.forEach((link) => {
      cy.visit(link);

      // Wait for app to load
      cy.get('#root', { timeout: 30000 }).should('exist');
      cy.document().its('readyState').should('equal', 'complete');

      // Verify URL preserved query parameters
      cy.url().should('include', link);

      // Refresh to ensure query params are preserved
      cy.reload();
      cy.get('#root', { timeout: 30000 }).should('exist');
      cy.url().should('include', link);
    });
  });

  it('handles invalid routes gracefully', () => {
    const invalidRoutes = ['/non-existent-route', '/another/invalid/path', '/12345'];

    invalidRoutes.forEach((route) => {
      cy.visit(route, { failOnStatusCode: false });

      // App should still load
      cy.get('#root', { timeout: 30000 }).should('exist');

      // Should either redirect to home or show a 404 component
      // but not show server error
      cy.get('body').should('not.contain.text', 'Client application not found');
      cy.get('body').should('not.contain.text', 'Failed to serve index.html');
    });
  });

  it('maintains application state during navigation', () => {
    // Set some state in localStorage
    cy.window().then((win) => {
      win.localStorage.setItem('test-key', 'test-value');
    });

    // Navigate to different route
    cy.visit('/create');
    cy.get('#root', { timeout: 30000 }).should('exist');

    // Verify state is preserved
    cy.window().its('localStorage').invoke('getItem', 'test-key').should('eq', 'test-value');

    // Refresh the page
    cy.reload();

    // Verify state is still preserved after refresh
    cy.window().its('localStorage').invoke('getItem', 'test-key').should('eq', 'test-value');
  });

  it('handles rapid navigation without errors', () => {
    const rapidRoutes = ['/create', '/settings/', '/logs', '/agents/new', '/group/new'];

    // Navigate rapidly through routes
    rapidRoutes.forEach((route) => {
      cy.visit(route);
      // Don't wait for full load, immediately navigate to next
    });

    // Final wait for last route to load
    cy.get('#root', { timeout: 30000 }).should('exist');
    cy.document().its('readyState').should('equal', 'complete');

    // Verify we ended up on the last route
    cy.url().should('include', '/group/new');

    // Verify app is still functional
    cy.get('[data-testid="app-sidebar"]').should('exist');
  });
});
