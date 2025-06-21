/// <reference types="cypress" />

describe('Plugin Configuration Management', () => {
  let agentId: string;

  beforeEach(() => {
    // Visit the application
    cy.visit('/');
    
    // Setup intercepts for API calls
    cy.intercept('GET', '/api/agents/*/configurations', { fixture: 'plugin-configurations.json' }).as('getConfigurations');
    cy.intercept('POST', '/api/agents/*/configurations/*/components/*/*/enable', { fixture: 'component-enable-response.json' }).as('enableComponent');
    cy.intercept('POST', '/api/agents/*/configurations/*/components/*/*/disable', { fixture: 'component-disable-response.json' }).as('disableComponent');
    cy.intercept('POST', '/api/agents/*/configurations/*/components/*/*/toggle', { fixture: 'component-toggle-response.json' }).as('toggleComponent');
    cy.intercept('GET', '/api/agents/*/configurations/*/runtime-status', { fixture: 'runtime-status.json' }).as('getRuntimeStatus');
    
    // Get agent ID from the UI or use a test agent
    cy.get('[data-testid="agent-card"]').first().should('exist').then(($el) => {
      agentId = $el.attr('data-agent-id') || 'test-agent-id';
    });
  });

  describe('Plugin Configuration Panel Access', () => {
    it('should open plugin configuration panel from plugins section', () => {
      // Navigate to agent settings or character form
      cy.get('[data-testid="agent-card"]').first().click();
      cy.get('[data-testid="agent-settings"]').click();
      
      // Find and click the plugin configuration button
      cy.contains('Configure Plugin Components').should('be.visible');
      cy.contains('Configure Plugin Components').click();
      
      // Verify the dialog opens
      cy.get('[role="dialog"]').should('be.visible');
      cy.contains('Plugin Component Configuration').should('be.visible');
    });

    it('should display loading state while fetching configurations', () => {
      // Delay the API response
      cy.intercept('GET', '/api/agents/*/configurations', { 
        delay: 1000,
        fixture: 'plugin-configurations.json' 
      }).as('getConfigurationsDelayed');
      
      // Open the panel
      cy.get('[data-testid="agent-card"]').first().click();
      cy.get('[data-testid="agent-settings"]').click();
      cy.contains('Configure Plugin Components').click();
      
      // Check loading state
      cy.contains('Loading configurations...').should('be.visible');
      cy.get('[data-testid="loading-spinner"]').should('be.visible');
      
      // Wait for loading to complete
      cy.wait('@getConfigurationsDelayed');
      cy.contains('Loading configurations...').should('not.exist');
    });
  });

  describe('Plugin List and Expansion', () => {
    beforeEach(() => {
      // Open the configuration panel
      cy.get('[data-testid="agent-card"]').first().click();
      cy.get('[data-testid="agent-settings"]').click();
      cy.contains('Configure Plugin Components').click();
      cy.wait('@getConfigurations');
    });

    it('should display list of plugins with status badges', () => {
      // Check that plugins are displayed
      cy.get('[data-testid^="plugin-"]').should('have.length.greaterThan', 0);
      
      // Check status badges
      cy.get('[data-testid="plugin-badge-enabled"]').should('exist');
      cy.get('[data-testid="plugin-badge-disabled"]').should('exist');
    });

    it('should expand and collapse plugin sections', () => {
      // Find the first plugin
      cy.get('[data-testid^="plugin-"]').first().as('firstPlugin');
      
      // Initially should be collapsed
      cy.get('@firstPlugin').find('[data-testid="plugin-content"]').should('not.be.visible');
      
      // Click to expand
      cy.get('@firstPlugin').find('[data-testid="plugin-trigger"]').click();
      
      // Should be expanded now
      cy.get('@firstPlugin').find('[data-testid="plugin-content"]').should('be.visible');
      
      // Click to collapse
      cy.get('@firstPlugin').find('[data-testid="plugin-trigger"]').click();
      
      // Should be collapsed again
      cy.get('@firstPlugin').find('[data-testid="plugin-content"]').should('not.be.visible');
    });

    it('should show runtime status button when plugin is expanded', () => {
      // Expand a plugin
      cy.get('[data-testid^="plugin-"]').first().as('firstPlugin');
      cy.get('@firstPlugin').find('[data-testid="plugin-trigger"]').click();
      
      // Runtime status button should be visible
      cy.get('@firstPlugin').find('[data-testid="runtime-status-button"]').should('be.visible');
      cy.get('@firstPlugin').find('[data-testid="runtime-status-button"]').should('contain', 'Show Runtime Status');
    });
  });

  describe('Component Type Sections', () => {
    beforeEach(() => {
      // Open the configuration panel and expand a plugin
      cy.get('[data-testid="agent-card"]').first().click();
      cy.get('[data-testid="agent-settings"]').click();
      cy.contains('Configure Plugin Components').click();
      cy.wait('@getConfigurations');
      
      cy.get('[data-testid^="plugin-"]').first().as('firstPlugin');
      cy.get('@firstPlugin').find('[data-testid="plugin-trigger"]').click();
    });

    it('should display component type sections with counts', () => {
      // Check for component type sections
      cy.get('[data-testid="section-actions"]').should('be.visible');
      cy.get('[data-testid="section-providers"]').should('be.visible');
      cy.get('[data-testid="section-evaluators"]').should('be.visible');
      cy.get('[data-testid="section-services"]').should('be.visible');
      
      // Check that sections show component counts
      cy.get('[data-testid="section-actions"]').should('contain', 'Actions (');
      cy.get('[data-testid="section-providers"]').should('contain', 'Providers (');
      cy.get('[data-testid="section-evaluators"]').should('contain', 'Evaluators (');
      cy.get('[data-testid="section-services"]').should('contain', 'Services (');
    });

    it('should expand and collapse component type sections', () => {
      // Expand actions section
      cy.get('[data-testid="section-actions"]').find('[data-testid="section-trigger"]').click();
      cy.get('[data-testid="section-actions"]').find('[data-testid="section-content"]').should('be.visible');
      
      // Collapse actions section
      cy.get('[data-testid="section-actions"]').find('[data-testid="section-trigger"]').click();
      cy.get('[data-testid="section-actions"]').find('[data-testid="section-content"]').should('not.be.visible');
    });
  });

  describe('Component Toggle Controls', () => {
    beforeEach(() => {
      // Open the configuration panel and navigate to components
      cy.get('[data-testid="agent-card"]').first().click();
      cy.get('[data-testid="agent-settings"]').click();
      cy.contains('Configure Plugin Components').click();
      cy.wait('@getConfigurations');
      
      cy.get('[data-testid^="plugin-"]').first().as('firstPlugin');
      cy.get('@firstPlugin').find('[data-testid="plugin-trigger"]').click();
      
      // Expand actions section
      cy.get('[data-testid="section-actions"]').find('[data-testid="section-trigger"]').click();
    });

    it('should display toggle buttons for each component', () => {
      // Check that components have toggle buttons
      cy.get('[data-testid^="component-toggle-"]').should('have.length.greaterThan', 0);
      
      // Check button states
      cy.get('[data-testid^="component-toggle-"]').first().as('firstToggle');
      cy.get('@firstToggle').should('contain.text', 'ON').or('contain.text', 'OFF');
    });

    it('should toggle component state on button click', () => {
      // Find the first toggle button
      cy.get('[data-testid^="component-toggle-"]').first().as('firstToggle');
      
      // Get initial state
      cy.get('@firstToggle').invoke('text').then((initialState) => {
        // Click the toggle button
        cy.get('@firstToggle').click();
        
        // Wait for API call
        cy.wait('@toggleComponent');
        
        // Check that state changed
        cy.get('@firstToggle').should('not.contain.text', initialState);
        
        // Check for success toast
        cy.get('[data-testid="toast"]').should('be.visible');
        cy.get('[data-testid="toast"]').should('contain', 'toggled successfully');
      });
    });

    it('should show loading state during component toggle', () => {
      // Delay the API response
      cy.intercept('POST', '/api/agents/*/configurations/*/components/*/*/toggle', {
        delay: 1000,
        fixture: 'component-toggle-response.json'
      }).as('toggleComponentDelayed');
      
      // Click toggle button
      cy.get('[data-testid^="component-toggle-"]').first().click();
      
      // Button should be disabled during request
      cy.get('[data-testid^="component-toggle-"]').first().should('be.disabled');
      
      // Wait for completion
      cy.wait('@toggleComponentDelayed');
      
      // Button should be enabled again
      cy.get('[data-testid^="component-toggle-"]').first().should('not.be.disabled');
    });

    it('should display error toast on toggle failure', () => {
      // Mock API error
      cy.intercept('POST', '/api/agents/*/configurations/*/components/*/*/toggle', {
        statusCode: 500,
        body: { success: false, error: { message: 'Toggle failed' } }
      }).as('toggleComponentError');
      
      // Click toggle button
      cy.get('[data-testid^="component-toggle-"]').first().click();
      
      // Wait for error response
      cy.wait('@toggleComponentError');
      
      // Check for error toast
      cy.get('[data-testid="toast"]').should('be.visible');
      cy.get('[data-testid="toast"]').should('contain', 'Failed to toggle component');
    });
  });

  describe('Runtime Status Monitoring', () => {
    beforeEach(() => {
      // Open the configuration panel and expand a plugin
      cy.get('[data-testid="agent-card"]').first().click();
      cy.get('[data-testid="agent-settings"]').click();
      cy.contains('Configure Plugin Components').click();
      cy.wait('@getConfigurations');
      
      cy.get('[data-testid^="plugin-"]').first().as('firstPlugin');
      cy.get('@firstPlugin').find('[data-testid="plugin-trigger"]').click();
    });

    it('should fetch and display runtime status when button is clicked', () => {
      // Click runtime status button
      cy.get('[data-testid="runtime-status-button"]').click();
      
      // Wait for API call
      cy.wait('@getRuntimeStatus');
      
      // Button text should change
      cy.get('[data-testid="runtime-status-button"]').should('contain', 'Hide Status');
      
      // Status badge should appear
      cy.get('[data-testid="runtime-status-badge"]').should('be.visible');
    });

    it('should show sync status indicators for components', () => {
      // Enable runtime status
      cy.get('[data-testid="runtime-status-button"]').click();
      cy.wait('@getRuntimeStatus');
      
      // Expand a component section
      cy.get('[data-testid="section-actions"]').find('[data-testid="section-trigger"]').click();
      
      // Check for sync status indicators
      cy.get('[data-testid^="sync-status-"]').should('exist');
      cy.get('[data-testid="sync-in-sync"]').should('exist');
      cy.get('[data-testid="sync-out-of-sync"]').should('exist');
    });

    it('should display detailed sync information', () => {
      // Enable runtime status
      cy.get('[data-testid="runtime-status-button"]').click();
      cy.wait('@getRuntimeStatus');
      
      // Expand a component section
      cy.get('[data-testid="section-actions"]').find('[data-testid="section-trigger"]').click();
      
      // Check for detailed sync info
      cy.get('[data-testid^="sync-details-"]').should('contain', 'Config:');
      cy.get('[data-testid^="sync-details-"]').should('contain', 'Runtime:');
    });
  });

  describe('Component Status Badges', () => {
    beforeEach(() => {
      // Open the configuration panel and navigate to components
      cy.get('[data-testid="agent-card"]').first().click();
      cy.get('[data-testid="agent-settings"]').click();
      cy.contains('Configure Plugin Components').click();
      cy.wait('@getConfigurations');
      
      cy.get('[data-testid^="plugin-"]').first().as('firstPlugin');
      cy.get('@firstPlugin').find('[data-testid="plugin-trigger"]').click();
      cy.get('[data-testid="section-actions"]').find('[data-testid="section-trigger"]').click();
    });

    it('should display status badges for each component', () => {
      // Check that each component has a status badge
      cy.get('[data-testid^="component-badge-"]').should('have.length.greaterThan', 0);
      
      // Check badge text
      cy.get('[data-testid^="component-badge-"]').each(($badge) => {
        cy.wrap($badge).should('contain.text', 'Enabled').or('contain.text', 'Disabled');
      });
    });

    it('should update badge when component is toggled', () => {
      // Find first component badge
      cy.get('[data-testid^="component-badge-"]').first().as('firstBadge');
      
      // Get initial badge text
      cy.get('@firstBadge').invoke('text').then((initialText) => {
        // Toggle the component
        cy.get('[data-testid^="component-toggle-"]').first().click();
        cy.wait('@toggleComponent');
        
        // Badge should update
        cy.get('@firstBadge').should('not.contain.text', initialText);
      });
    });
  });

  describe('Real-time Updates', () => {
    it('should handle WebSocket component enabled events', () => {
      // Open the configuration panel
      cy.get('[data-testid="agent-card"]').first().click();
      cy.get('[data-testid="agent-settings"]').click();
      cy.contains('Configure Plugin Components').click();
      cy.wait('@getConfigurations');
      
      // Simulate WebSocket event
      cy.window().then((win) => {
        const event = new CustomEvent('component_enabled', {
          detail: {
            agentId: agentId,
            pluginName: 'test-plugin',
            componentType: 'action',
            componentName: 'TEST_ACTION',
            timestamp: new Date().toISOString()
          }
        });
        win.dispatchEvent(event);
      });
      
      // UI should update automatically
      // Note: In a real test, this would trigger a data refetch
      cy.get('[data-testid="toast"]').should('be.visible');
    });

    it('should handle WebSocket component disabled events', () => {
      // Open the configuration panel
      cy.get('[data-testid="agent-card"]').first().click();
      cy.get('[data-testid="agent-settings"]').click();
      cy.contains('Configure Plugin Components').click();
      cy.wait('@getConfigurations');
      
      // Simulate WebSocket event
      cy.window().then((win) => {
        const event = new CustomEvent('component_disabled', {
          detail: {
            agentId: agentId,
            pluginName: 'test-plugin',
            componentType: 'action',
            componentName: 'TEST_ACTION',
            timestamp: new Date().toISOString()
          }
        });
        win.dispatchEvent(event);
      });
      
      // UI should update automatically
      cy.get('[data-testid="toast"]').should('be.visible');
    });
  });

  describe('Panel Controls', () => {
    beforeEach(() => {
      // Open the configuration panel
      cy.get('[data-testid="agent-card"]').first().click();
      cy.get('[data-testid="agent-settings"]').click();
      cy.contains('Configure Plugin Components').click();
      cy.wait('@getConfigurations');
    });

    it('should refresh configurations when refresh button is clicked', () => {
      // Click refresh button
      cy.get('[data-testid="refresh-button"]').click();
      
      // Should trigger new API call
      cy.wait('@getConfigurations');
      
      // Loading state should appear briefly
      cy.get('[data-testid="loading-spinner"]').should('be.visible');
    });

    it('should close panel when close button is clicked', () => {
      // Click close button
      cy.get('[data-testid="close-button"]').click();
      
      // Dialog should close
      cy.get('[role="dialog"]').should('not.exist');
    });

    it('should close panel when clicking outside', () => {
      // Click outside the dialog
      cy.get('[data-testid="dialog-overlay"]').click({ force: true });
      
      // Dialog should close
      cy.get('[role="dialog"]').should('not.exist');
    });
  });

  describe('Accessibility', () => {
    beforeEach(() => {
      // Open the configuration panel
      cy.get('[data-testid="agent-card"]').first().click();
      cy.get('[data-testid="agent-settings"]').click();
      cy.contains('Configure Plugin Components').click();
      cy.wait('@getConfigurations');
    });

    it('should be navigable with keyboard', () => {
      // Tab through interactive elements
      cy.get('body').tab();
      cy.focused().should('have.attr', 'data-testid', 'close-button');
      
      cy.focused().tab();
      cy.focused().should('have.attr', 'data-testid', 'refresh-button');
    });

    it('should have proper ARIA labels', () => {
      // Check for ARIA labels on important elements
      cy.get('[role="dialog"]').should('have.attr', 'aria-labelledby');
      cy.get('[data-testid^="plugin-trigger"]').should('have.attr', 'aria-expanded');
      cy.get('[data-testid^="section-trigger"]').should('have.attr', 'aria-expanded');
    });

    it('should support screen reader announcements', () => {
      // Check for aria-live regions
      cy.get('[aria-live="polite"]').should('exist');
      
      // Toggle a component and check for announcements
      cy.get('[data-testid^="plugin-"]').first().click();
      cy.get('[data-testid="section-actions"]').find('[data-testid="section-trigger"]').click();
      cy.get('[data-testid^="component-toggle-"]').first().click();
      
      // Toast should have proper role
      cy.get('[data-testid="toast"]').should('have.attr', 'role', 'alert');
    });
  });
});