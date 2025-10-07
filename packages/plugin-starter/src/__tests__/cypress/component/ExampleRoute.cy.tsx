/// <reference types="cypress" />
/// <reference types="@cypress/react" />
/// <reference types="@testing-library/cypress" />

import React from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import '../../../frontend/index.css';

// Define the interface for time response
interface TimeResponse {
  timestamp: string;
  unix: number;
  formatted: string;
  timezone: string;
}

// Define ELIZA config interface
interface ElizaConfig {
  agentId: string;
  apiBase?: string; // Make optional to fix type error
}

declare global {
  interface Window {
    ELIZA_CONFIG: ElizaConfig | undefined;
  }
}

describe('ExampleRoute Component Tests', () => {
  // Component definitions inside describe block to have access to cy
  const TimeDisplay = ({ apiBase }: { apiBase: string }) => {
    const { data, isLoading, error, refetch } = useQuery<TimeResponse>({
      queryKey: ['currentTime'],
      queryFn: async () => {
        const response = await fetch(`${apiBase}/api/time`);
        if (!response.ok) {
          throw new Error('Failed to fetch time');
        }
        return response.json();
      },
      refetchInterval: 1000, // Refresh every second
    });

    if (isLoading) {
      return <div className="text-gray-600">Loading time...</div>;
    }

    if (error) {
      return (
        <div className="text-red-600">
          Error fetching time: {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      );
    }

    return (
      <div className="space-y-2" data-testid="time-display">
        <h2 className="text-lg font-semibold">Current Time</h2>
        <div className="space-y-1 text-sm">
          <div>
            <span className="font-medium">Formatted:</span> {data?.formatted}
          </div>
          <div>
            <span className="font-medium">Timezone:</span> {data?.timezone}
          </div>
          <div>
            <span className="font-medium">Unix:</span> {data?.unix}
          </div>
        </div>
        <button
          onClick={() => refetch()}
          className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:opacity-90"
          data-testid="refresh-button"
        >
          Refresh
        </button>
      </div>
    );
  };

  const ExampleRoute = () => {
    const [config] = React.useState(window.ELIZA_CONFIG);
    const apiBase = config?.apiBase || 'http://localhost:3000';

    React.useEffect(() => {
      document.documentElement.classList.add('dark');
    }, []);

    if (!config?.agentId) {
      return (
        <div className="p-4 text-center">
          <div className="text-red-600 font-medium">Error: Agent ID not found</div>
          <div className="text-sm text-gray-600 mt-2">
            The server should inject the agent ID configuration.
          </div>
        </div>
      );
    }

    return (
      <QueryClientProvider client={new QueryClient()}>
        <div className="p-6 space-y-6">
          <div>
            <h1 className="text-2xl font-bold mb-2">Plugin Starter Example</h1>
            <div className="text-sm text-muted-foreground">Agent ID: {config.agentId}</div>
          </div>
          <TimeDisplay apiBase={apiBase} />
        </div>
      </QueryClientProvider>
    );
  };

  describe('Component Rendering', () => {
    it('should apply dark mode on mount', () => {
      cy.mount(<ExampleRoute />);
      cy.shouldBeDarkMode();
    });

    it('should show error when agent ID is missing', () => {
      // Clear the config before mounting
      cy.window().then((win) => {
        win.ELIZA_CONFIG = undefined;
      });

      cy.mount(<ExampleRoute />);

      // Check error message is displayed
      cy.contains('Error: Agent ID not found').should('be.visible');
      cy.contains('The server should inject the agent ID configuration.').should('be.visible');
    });

    it('should render correctly with agent ID', () => {
      const testAgentId = '12345678-1234-1234-1234-123456789abc';

      // Set config before mounting
      cy.window().then((win) => {
        win.ELIZA_CONFIG = {
          agentId: testAgentId,
          apiBase: 'http://localhost:3000',
        };
      });

      cy.mount(<ExampleRoute />);

      // Check that the agent ID is displayed
      cy.contains('Plugin Starter Example').should('be.visible');
      cy.contains(`Agent ID: ${testAgentId}`).should('be.visible');
    });
  });

  describe('API Communication', () => {
    beforeEach(() => {
      // Set up ELIZA_CONFIG
      cy.window().then((win) => {
        win.ELIZA_CONFIG = {
          agentId: 'test-agent-123',
          apiBase: 'http://localhost:3000',
        };
      });
    });

    it('should fetch and display time from backend', () => {
      // Mock the API response
      cy.intercept('GET', '**/api/time', {
        statusCode: 200,
        body: {
          timestamp: '2024-01-01T12:00:00.000Z',
          unix: 1704110400,
          formatted: '1/1/2024, 12:00:00 PM',
          timezone: 'UTC',
        },
      }).as('getTime');

      cy.mount(<ExampleRoute />);

      // Wait for the API call
      cy.wait('@getTime');

      // Check that time data is displayed
      cy.get('[data-testid="time-display"]').should('be.visible');
      cy.contains('Current Time').should('be.visible');
      cy.contains('Formatted: 1/1/2024, 12:00:00 PM').should('be.visible');
      cy.contains('Timezone: UTC').should('be.visible');
      cy.contains('Unix: 1704110400').should('be.visible');
    });

    it('should refresh time when refresh button is clicked', () => {
      let callCount = 0;

      // Mock multiple API responses
      cy.intercept('GET', '**/api/time', (req) => {
        callCount++;
        req.reply({
          statusCode: 200,
          body: {
            timestamp: new Date().toISOString(),
            unix: Math.floor(Date.now() / 1000) + callCount,
            formatted: `Call ${callCount}: ${new Date().toLocaleString()}`,
            timezone: 'UTC',
          },
        });
      }).as('getTime');

      cy.mount(<ExampleRoute />);

      // Wait for initial load
      cy.wait('@getTime');
      cy.contains('Call 1:').should('be.visible');

      // Click refresh button
      cy.get('[data-testid="refresh-button"]').click();

      // Wait for refresh
      cy.wait('@getTime');
      cy.contains('Call 2:').should('be.visible');
    });

    it('should verify auto-refresh behavior', () => {
      let callCount = 0;

      cy.intercept('GET', '**/api/time', (req) => {
        callCount++;
        req.reply({
          statusCode: 200,
          body: {
            timestamp: new Date().toISOString(),
            unix: Math.floor(Date.now() / 1000),
            formatted: `Update ${callCount}`,
            timezone: 'UTC',
          },
        });
      }).as('getTime');

      cy.mount(<ExampleRoute />);

      // Wait for initial load
      cy.wait('@getTime');
      cy.contains('Update 1').should('be.visible');

      // Verify multiple API calls happen due to auto-refresh
      cy.wait('@getTime', { timeout: 2000 });
      cy.get('@getTime.all').should('have.length.greaterThan', 1);
    });

    it('should show loading state', () => {
      // Add delay to see loading state
      cy.intercept('GET', '**/api/time', (req) => {
        // Instead of req.reply with a callback, use a simpler approach
        req.reply({
          statusCode: 200,
          body: {
            timestamp: new Date().toISOString(),
            unix: Math.floor(Date.now() / 1000),
            formatted: new Date().toLocaleString(),
            timezone: 'UTC',
          },
          delay: 1000, // Add delay directly
        });
      }).as('getTimeDelayed');

      cy.mount(<ExampleRoute />);

      // Check loading state
      cy.contains('Loading time...').should('be.visible');

      // Wait for data to load
      cy.wait('@getTimeDelayed');
      cy.contains('Loading time...').should('not.exist');
      cy.get('[data-testid="time-display"]').should('be.visible');
    });
  });

  describe('Configuration Handling', () => {
    it('should handle different API base URLs', () => {
      const customApiBase = 'https://api.example.com';

      cy.window().then((win) => {
        win.ELIZA_CONFIG = {
          agentId: 'test-agent',
          apiBase: customApiBase,
        };
      });

      // Intercept with custom base URL
      cy.intercept('GET', `${customApiBase}/api/time`, {
        statusCode: 200,
        body: {
          timestamp: new Date().toISOString(),
          unix: Math.floor(Date.now() / 1000),
          formatted: 'Custom API Response',
          timezone: 'UTC',
        },
      }).as('getTimeCustom');

      cy.mount(<ExampleRoute />);

      cy.wait('@getTimeCustom');
      cy.contains('Custom API Response').should('be.visible');
    });

    it('should use default API base when not provided', () => {
      cy.window().then((win) => {
        win.ELIZA_CONFIG = {
          agentId: 'test-agent',
          // No apiBase provided - this is now valid with optional apiBase
        };
      });

      // Intercept with default base URL
      cy.intercept('GET', 'http://localhost:3000/api/time', {
        statusCode: 200,
        body: {
          timestamp: new Date().toISOString(),
          unix: Math.floor(Date.now() / 1000),
          formatted: 'Default API Response',
          timezone: 'UTC',
        },
      }).as('getTimeDefault');

      cy.mount(<ExampleRoute />);

      cy.wait('@getTimeDefault');
      cy.contains('Default API Response').should('be.visible');
    });
  });

  describe('Accessibility', () => {
    beforeEach(() => {
      cy.window().then((win) => {
        win.ELIZA_CONFIG = {
          agentId: 'test-agent',
          apiBase: 'http://localhost:3000',
        };
      });

      cy.intercept('GET', '**/api/time', {
        statusCode: 200,
        body: {
          timestamp: new Date().toISOString(),
          unix: Math.floor(Date.now() / 1000),
          formatted: new Date().toLocaleString(),
          timezone: 'UTC',
        },
      }).as('getTime');
    });

    it('should have proper heading hierarchy', () => {
      cy.mount(<ExampleRoute />);
      cy.wait('@getTime');

      // Check h1 exists
      cy.get('h1').contains('Plugin Starter Example').should('be.visible');

      // Check h2 exists
      cy.get('h2').contains('Current Time').should('be.visible');
    });

    it('should have accessible button', () => {
      cy.mount(<ExampleRoute />);
      cy.wait('@getTime');

      // Button should be focusable and clickable
      cy.get('[data-testid="refresh-button"]')
        .should('be.visible')
        .should('not.be.disabled')
        .focus()
        .should('have.focus');
    });
  });
});

/**
 * TESTING PATTERNS FOR FRONTEND COMPONENTS IN ELIZAOS
 *
 * 1. COMPONENT ISOLATION
 *    - Test components in isolation using cy.mount()
 *    - Mock external dependencies (like API calls)
 *    - Use data-testid attributes for reliable element selection
 *
 * 2. CONFIGURATION TESTING
 *    - Always test with and without ELIZA_CONFIG
 *    - Test with invalid/malformed configurations
 *    - Verify error states and fallbacks
 *
 * 3. DARK MODE SUPPORT
 *    - Ensure components work in both light and dark modes
 *    - Use the custom shouldBeDarkMode() command
 *
 * 4. QUERY CLIENT TESTING
 *    - Mock API responses for react-query
 *    - Test loading, error, and success states
 *    - Verify cache behavior
 *
 * 5. ACCESSIBILITY
 *    - Use Testing Library queries (findByRole, findByText)
 *    - Test keyboard navigation
 *    - Verify ARIA attributes
 *
 * 6. API INTEGRATION TESTING
 *    - Mock all external API calls
 *    - Test error handling
 *    - Verify retry logic
 *    - Test different response scenarios
 */
