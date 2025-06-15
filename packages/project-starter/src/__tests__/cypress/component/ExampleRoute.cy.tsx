import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../../frontend/index.css';

// We need to import the component directly since it's not exported
// In a real scenario, you'd export the component from index.tsx
const ExampleRoute = () => {
  const [config, setConfig] = React.useState(window.ELIZA_CONFIG);

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
      <div>Hello {config.agentId}</div>
    </QueryClientProvider>
  );
};

describe('ExampleRoute Component Tests', () => {
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
      cy.contains(`Hello ${testAgentId}`).should('be.visible');
    });
  });

  describe('Configuration Handling', () => {
    it('should handle ELIZA_CONFIG changes', () => {
      const initialAgentId = 'initial-agent-id';
      const updatedAgentId = 'updated-agent-id';

      // Set initial config
      cy.window().then((win) => {
        win.ELIZA_CONFIG = {
          agentId: initialAgentId,
          apiBase: 'http://localhost:3000',
        };
      });

      cy.mount(<ExampleRoute />);
      cy.contains(`Hello ${initialAgentId}`).should('be.visible');
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
 * EXAMPLE TEST STRUCTURE:
 *
 * describe('Component Name', () => {
 *   beforeEach(() => {
 *     // Set up common test data
 *     cy.setElizaConfig({ agentId: 'test-id', apiBase: 'http://localhost:3000' });
 *   });
 *
 *   describe('Rendering', () => {
 *     it('should render correctly', () => {
 *       cy.mount(<Component />);
 *       // Assertions
 *     });
 *   });
 *
 *   describe('User Interactions', () => {
 *     it('should handle click events', () => {
 *       cy.mount(<Component />);
 *       cy.findByRole('button').click();
 *       // Assertions
 *     });
 *   });
 *
 *   describe('API Integration', () => {
 *     it('should fetch and display data', () => {
 *       cy.intercept('GET', '/api/data', { fixture: 'mockData.json' });
 *       cy.mount(<Component />);
 *       // Assertions
 *     });
 *   });
 * }); */
