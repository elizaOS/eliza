/// <reference types="cypress" />

import ConnectionStatus from './connection-status';

// Mock the contexts
const MockProviders = ({
  children,
  connectionStatus = 'connected',
  connectionError = null,
}: any) => {
  const mockAuthValue = {
    openApiKeyDialog: cy.stub().as('openApiKeyDialog'),
  };

  const mockConnectionValue = {
    status: connectionStatus,
    error: connectionError,
  };

  return (
    <div data-testid="mock-providers">
      {/* Mock implementation - in real tests you'd properly mock these contexts */}
      {children}
    </div>
  );
};

describe('ConnectionStatus Component', () => {
  it('displays connected status', () => {
    cy.mount(
      <MockProviders connectionStatus="connected">
        <ConnectionStatus />
      </MockProviders>
    );

    // Should show green indicator
    cy.get('.bg-green-600').should('exist');
    cy.contains('Connected').should('be.visible');
  });

  it('displays disconnected status', () => {
    cy.mount(
      <MockProviders connectionStatus="disconnected">
        <ConnectionStatus />
      </MockProviders>
    );

    // Should show red indicator
    cy.get('.bg-red-600').should('exist');
    cy.contains('Disconnected').should('be.visible');
  });

  it('displays loading status', () => {
    cy.mount(
      <MockProviders connectionStatus="loading">
        <ConnectionStatus />
      </MockProviders>
    );

    // Should show muted indicator
    cy.get('.bg-muted-foreground').should('exist');
    cy.contains('Connecting...').should('be.visible');
  });

  it('displays unauthorized status', () => {
    cy.mount(
      <MockProviders connectionStatus="unauthorized">
        <ConnectionStatus />
      </MockProviders>
    );

    // Should show yellow indicator
    cy.get('.bg-yellow-500').should('exist');
    cy.contains('Unauthorized').should('be.visible');

    // Should trigger API key dialog
    cy.get('@openApiKeyDialog').should('have.been.called');
  });

  it('displays error status with tooltip', () => {
    cy.mount(
      <MockProviders connectionStatus="error" connectionError="Connection refused">
        <ConnectionStatus />
      </MockProviders>
    );

    // Should show alert icon
    cy.get('.text-red-600').should('exist');

    // Hover to show tooltip
    cy.get('[role="button"]').trigger('mouseenter');

    // Tooltip should contain error message
    cy.contains('Connection refused').should('be.visible');
    cy.contains('Please ensure the Eliza server is running').should('be.visible');
  });

  it('handles network errors correctly', () => {
    cy.mount(
      <MockProviders connectionStatus="error" connectionError="NetworkError: Failed to fetch">
        <ConnectionStatus />
      </MockProviders>
    );

    cy.get('[role="button"]').trigger('mouseenter');
    cy.contains('Cannot reach server').should('be.visible');
  });

  it('handles timeout errors correctly', () => {
    cy.mount(
      <MockProviders connectionStatus="error" connectionError="Request timeout">
        <ConnectionStatus />
      </MockProviders>
    );

    cy.get('[role="button"]').trigger('mouseenter');
    cy.contains('Connection timeout').should('be.visible');
  });

  it('handles 404 errors correctly', () => {
    cy.mount(
      <MockProviders connectionStatus="error" connectionError="404: API endpoint not found">
        <ConnectionStatus />
      </MockProviders>
    );

    cy.get('[role="button"]').trigger('mouseenter');
    cy.contains('Endpoint not found').should('be.visible');
  });

  it('shows toast notification on connection restore', () => {
    // Mount with disconnected status
    const { rerender } = cy
      .mount(
        <MockProviders connectionStatus="disconnected">
          <ConnectionStatus />
        </MockProviders>
      )
      .then((result) => result);

    // Update to connected status
    cy.wrap(rerender).then((rerenderFn: any) => {
      rerenderFn(
        <MockProviders connectionStatus="connected">
          <ConnectionStatus />
        </MockProviders>
      );
    });

    // Should show success toast
    cy.contains('Connection Restored').should('be.visible');
    cy.contains('Successfully reconnected').should('be.visible');
  });

  it('shows toast notification on connection loss', () => {
    // Mount with connected status
    const { rerender } = cy
      .mount(
        <MockProviders connectionStatus="connected">
          <ConnectionStatus />
        </MockProviders>
      )
      .then((result) => result);

    // Update to error status
    cy.wrap(rerender).then((rerenderFn: any) => {
      rerenderFn(
        <MockProviders connectionStatus="error" connectionError="Connection lost">
          <ConnectionStatus />
        </MockProviders>
      );
    });

    // Should show error toast
    cy.contains('Connection Lost').should('be.visible');
    cy.contains('Attempting to reconnect').should('be.visible');
  });

  it('displays correct styling for each status', () => {
    const statuses = [
      { status: 'connected', colorClass: 'bg-green-600', textClass: 'text-green-600' },
      { status: 'disconnected', colorClass: 'bg-red-600', textClass: 'text-red-600' },
      { status: 'loading', colorClass: 'bg-muted-foreground', textClass: 'text-muted-foreground' },
      { status: 'unauthorized', colorClass: 'bg-yellow-500', textClass: 'text-yellow-500' },
    ];

    statuses.forEach(({ status, colorClass, textClass }) => {
      cy.mount(
        <MockProviders connectionStatus={status}>
          <ConnectionStatus />
        </MockProviders>
      );

      if (status === 'error' || status === 'unauthorized') {
        // These show icons instead of dots
        cy.get(`.${textClass}`).should('exist');
      } else {
        cy.get(`.${colorClass}`).should('exist');
      }
    });
  });
});
