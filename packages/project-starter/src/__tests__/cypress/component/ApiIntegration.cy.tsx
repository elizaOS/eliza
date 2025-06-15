import React from 'react';
import '../../../frontend/index.css';

/**
 * Example component that fetches data from an API using React state
 */
const DataFetchingComponent: React.FC<{ agentId: string }> = ({ agentId }) => {
  const [data, setData] = React.useState<any>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    const fetchData = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const response = await fetch(`/api/agent/${agentId}/data`);
        if (!response.ok) {
          throw new Error('Failed to fetch data');
        }
        const result = await response.json();
        setData(result);
      } catch (err) {
        setError(err as Error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [agentId]);

  if (isLoading) return <div data-testid="loading">Loading agent data...</div>;
  if (error)
    return (
      <div data-testid="error" className="text-red-500">
        Error: {error.message}
      </div>
    );

  return (
    <div data-testid="data-display">
      <h2>Agent: {agentId}</h2>
      <ul>{data?.items?.map((item: string, index: number) => <li key={index}>{item}</li>)}</ul>
    </div>
  );
};

describe('API Integration Tests', () => {
  describe('Data Fetching', () => {
    it('should display loading state initially', () => {
      cy.intercept('GET', '/api/agent/*/data', {
        delay: 1000,
        body: { items: [] },
      });

      cy.mount(<DataFetchingComponent agentId="test-123" />);
      cy.get('[data-testid="loading"]').should('be.visible');
      cy.get('[data-testid="loading"]').should('contain', 'Loading agent data...');
    });

    it('should fetch and display data successfully', () => {
      const mockData = {
        items: ['Action 1', 'Action 2', 'Action 3'],
      };

      cy.intercept('GET', '/api/agent/test-123/data', {
        statusCode: 200,
        body: mockData,
      }).as('getAgentData');

      cy.mount(<DataFetchingComponent agentId="test-123" />);

      // Wait for the API call
      cy.wait('@getAgentData');

      // Check data is displayed
      cy.get('[data-testid="data-display"]').should('be.visible');
      cy.contains('Agent: test-123').should('be.visible');
      cy.contains('Action 1').should('be.visible');
      cy.contains('Action 2').should('be.visible');
      cy.contains('Action 3').should('be.visible');
    });

    it('should handle API errors gracefully', () => {
      cy.intercept('GET', '/api/agent/test-123/data', {
        statusCode: 500,
        body: { error: 'Internal Server Error' },
      }).as('getAgentDataError');

      cy.mount(<DataFetchingComponent agentId="test-123" />);

      // Wait for the failed API call
      cy.wait('@getAgentDataError');

      // Check error is displayed
      cy.get('[data-testid="error"]').should('be.visible');
      cy.get('[data-testid="error"]').should('contain', 'Failed to fetch data');
      cy.get('[data-testid="error"]').should('have.class', 'text-red-500');
    });

    it('should handle network errors', () => {
      cy.intercept('GET', '/api/agent/test-123/data', {
        forceNetworkError: true,
      }).as('networkError');

      cy.mount(<DataFetchingComponent agentId="test-123" />);

      // Network errors might not trigger the wait, so we check for error directly
      cy.get('[data-testid="error"]', { timeout: 10000 }).should('be.visible');
    });

    it('should refetch data when agent ID changes', () => {
      const firstMockData = { items: ['First Agent Action'] };
      const secondMockData = { items: ['Second Agent Action'] };

      cy.intercept('GET', '/api/agent/agent-1/data', {
        body: firstMockData,
      }).as('getFirstAgent');

      cy.intercept('GET', '/api/agent/agent-2/data', {
        body: secondMockData,
      }).as('getSecondAgent');

      // Create a component that can change agent ID
      const TestWrapper = () => {
        const [agentId, setAgentId] = React.useState('agent-1');

        return (
          <>
            <button onClick={() => setAgentId('agent-2')} data-testid="change-agent">
              Change Agent
            </button>
            <DataFetchingComponent agentId={agentId} />
          </>
        );
      };

      cy.mount(<TestWrapper />);
      cy.wait('@getFirstAgent');
      cy.contains('First Agent Action').should('be.visible');

      // Click to change agent
      cy.get('[data-testid="change-agent"]').click();
      cy.wait('@getSecondAgent');
      cy.contains('Second Agent Action').should('be.visible');
      cy.contains('First Agent Action').should('not.exist');
    });
  });

  describe('Request Validation', () => {
    it('should send correct headers', () => {
      cy.intercept('GET', '/api/agent/*/data', (req) => {
        expect(req.headers).to.have.property('accept');
        req.reply({ items: [] });
      }).as('checkHeaders');

      cy.mount(<DataFetchingComponent agentId="test-123" />);
      cy.wait('@checkHeaders');
    });

    it('should handle different response formats', () => {
      // Test empty response
      cy.intercept('GET', '/api/agent/empty/data', {
        body: {},
      }).as('emptyResponse');
      cy.mount(<DataFetchingComponent agentId="empty" />);
      cy.wait('@emptyResponse');
      cy.get('[data-testid="data-display"]').should('be.visible');

      // Test null items
      cy.intercept('GET', '/api/agent/null/data', {
        body: { items: null },
      }).as('nullResponse');
      // Create a new mount point for the second test
      cy.then(() => {
        cy.mount(<DataFetchingComponent agentId="null" />);
        cy.wait('@nullResponse');
        cy.get('[data-testid="data-display"]').should('be.visible');
      });
    });
  });
});

/**
 * API TESTING PATTERNS IN CYPRESS
 *
 * 1. INTERCEPTING REQUESTS
 *    cy.intercept() allows you to:
 *    - Mock responses
 *    - Delay responses
 *    - Force errors
 *    - Validate request data
 *
 * 2. WAITING FOR REQUESTS
 *    Use aliases with .as() and cy.wait() to ensure
 *    requests complete before making assertions
 *
 * 3. ERROR SCENARIOS
 *    Test all error cases:
 *    - Server errors (4xx, 5xx)
 *    - Network failures
 *    - Timeout scenarios
 *    - Invalid responses
 *
 * 4. LOADING STATES
 *    Always test loading indicators
 *    Use delays to ensure they appear
 *
 * 5. DATA UPDATES
 *    Test how components handle:
 *    - Prop changes
 *    - Refetching
 *    - Cache invalidation
 *
 * NOTE: This example uses plain React state instead of React Query
 * to avoid dependency optimization issues in the test environment.
 * In production, you would typically use React Query or similar
 * libraries for better caching and request management.
 */
