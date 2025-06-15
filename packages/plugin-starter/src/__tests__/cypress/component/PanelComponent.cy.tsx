import React from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { panels } from '../../../frontend/index';

// Time response interface
interface TimeResponse {
  timestamp: string;
  unix: number;
  formatted: string;
  timezone: string;
}

// Enhanced Panel Component with time display
const EnhancedPanelComponent: React.FC<{ agentId: string }> = ({ agentId }) => {
  const apiBase = window.ELIZA_CONFIG?.apiBase || 'http://localhost:3000';

  const {
    data: timeData,
    isLoading,
    error,
  } = useQuery<TimeResponse>({
    queryKey: ['panelTime', agentId],
    queryFn: async () => {
      const response = await fetch(`${apiBase}/api/time`);
      if (!response.ok) {
        throw new Error('Failed to fetch time');
      }
      return response.json();
    },
    refetchInterval: 5000, // Refresh every 5 seconds
  });

  return (
    <div className="p-4 space-y-4">
      <div>
        <h2 className="text-lg font-semibold mb-2">Example Panel</h2>
        <div>Hello {agentId}!</div>
      </div>

      <div className="border-t pt-4">
        <h3 className="text-md font-medium mb-2">Server Time</h3>
        {isLoading && <div className="text-gray-600">Loading time...</div>}
        {error && <div className="text-red-600">Error loading time</div>}
        {timeData && (
          <div className="text-sm space-y-1">
            <div>Time: {timeData.formatted}</div>
            <div className="text-gray-600">Timezone: {timeData.timezone}</div>
          </div>
        )}
      </div>
    </div>
  );
};

describe('PanelComponent Tests', () => {
  // Get the Panel component from the exported panels
  const PanelComponent = panels[0]?.component;

  describe('Panel Registration', () => {
    it('should export panels array with correct structure', () => {
      expect(panels).to.be.an('array');
      expect(panels).to.have.length.greaterThan(0);

      const panel = panels[0];
      expect(panel).to.have.property('name', 'Example');
      expect(panel).to.have.property('path', 'example');
      expect(panel).to.have.property('component');
      expect(panel).to.have.property('icon', 'Book');
      expect(panel).to.have.property('public', false);
      expect(panel).to.have.property('shortLabel', 'Example');
    });
  });

  describe('Component Rendering', () => {
    it('should render with agent ID', () => {
      const testAgentId = 'test-agent-12345';

      if (!PanelComponent) {
        throw new Error('PanelComponent not found in panels export');
      }

      cy.mount(<PanelComponent agentId={testAgentId} />);

      // Updated to match the corrected text in the component
      cy.contains(`Hello ${testAgentId}!`).should('be.visible');
    });

    it('should handle different agent IDs', () => {
      const agentIds = ['agent-1', 'agent-2', '12345678-1234-1234-1234-123456789abc', 'test-agent'];

      agentIds.forEach((agentId) => {
        cy.mount(<PanelComponent agentId={agentId} />);
        cy.contains(`Hello ${agentId}!`).should('be.visible');
      });
    });

    it('should render without crashing with empty agent ID', () => {
      cy.mount(<PanelComponent agentId="" />);
      cy.contains('Hello !').should('be.visible');
    });
  });

  describe('Enhanced Panel with Time Display', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    beforeEach(() => {
      // Set up ELIZA_CONFIG for API testing
      cy.window().then((win) => {
        win.ELIZA_CONFIG = {
          agentId: 'test-agent',
          apiBase: 'http://localhost:3000',
        };
      });
    });

    it('should fetch and display time in panel', () => {
      cy.intercept('GET', '**/api/time', {
        statusCode: 200,
        body: {
          timestamp: '2024-01-01T12:00:00.000Z',
          unix: 1704110400,
          formatted: '1/1/2024, 12:00:00 PM',
          timezone: 'America/New_York',
        },
      }).as('getPanelTime');

      cy.mount(
        <QueryClientProvider client={queryClient}>
          <EnhancedPanelComponent agentId="test-panel-123" />
        </QueryClientProvider>
      );

      // Wait for API call
      cy.wait('@getPanelTime');

      // Check panel content
      cy.contains('Example Panel').should('be.visible');
      cy.contains('Hello test-panel-123!').should('be.visible');

      // Check time display
      cy.contains('Server Time').should('be.visible');
      cy.contains('Time: 1/1/2024, 12:00:00 PM').should('be.visible');
      cy.contains('Timezone: America/New_York').should('be.visible');
    });

    it('should handle API errors in panel', () => {
      cy.intercept('GET', '**/api/time', {
        statusCode: 500,
        body: { error: 'Server error' },
      }).as('getPanelTimeError');

      cy.mount(
        <QueryClientProvider client={queryClient}>
          <EnhancedPanelComponent agentId="test-panel-error" />
        </QueryClientProvider>
      );

      // Wait for failed API call
      cy.wait('@getPanelTimeError');

      // Check error display
      cy.contains('Error loading time').should('be.visible');
    });

    it('should show loading state in panel', () => {
      cy.intercept('GET', '**/api/time', (req) => {
        // Use simpler delay approach
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
      }).as('getPanelTimeDelayed');

      cy.mount(
        <QueryClientProvider client={queryClient}>
          <EnhancedPanelComponent agentId="test-panel-loading" />
        </QueryClientProvider>
      );

      // Check loading state
      cy.contains('Loading time...').should('be.visible');

      // Wait for data
      cy.wait('@getPanelTimeDelayed');
      cy.contains('Loading time...').should('not.exist');
    });
  });

  describe('Panel Integration', () => {
    it('should integrate with agent UI system', () => {
      // Verify panel can be used in the agent UI
      const panel = panels[0];

      // Create a mock agent UI container
      const AgentUIContainer = ({ agentId }: { agentId: string }) => {
        const Component = panel.component;
        return (
          <div className="agent-ui-container">
            <div className="panel-header">
              <span className="panel-icon">{panel.icon}</span>
              <span className="panel-name">{panel.name}</span>
            </div>
            <div className="panel-content">
              <Component agentId={agentId} />
            </div>
          </div>
        );
      };

      cy.mount(<AgentUIContainer agentId="ui-test-agent" />);

      // Verify integration
      cy.get('.agent-ui-container').should('be.visible');
      cy.get('.panel-icon').contains('Book').should('be.visible');
      cy.get('.panel-name').contains('Example').should('be.visible');
      cy.get('.panel-content').contains('Hello ui-test-agent!').should('be.visible');
    });

    it('should handle panel switching', () => {
      // Simulate multiple panels
      const mockPanels = [
        ...panels,
        {
          name: 'Second Panel',
          path: 'second',
          component: ({ agentId }: { agentId: string }) => <div>Second panel for {agentId}</div>,
          icon: 'Settings',
          public: false,
          shortLabel: 'Second',
        },
      ];

      let currentPanel = 0;

      const PanelSwitcher = () => {
        const [activePanel, setActivePanel] = React.useState(0);
        const ActiveComponent = mockPanels[activePanel].component;

        return (
          <div>
            <div className="panel-tabs">
              {mockPanels.map((panel, index) => (
                <button
                  key={panel.path}
                  onClick={() => setActivePanel(index)}
                  className={activePanel === index ? 'active' : ''}
                  data-testid={`tab-${panel.path}`}
                >
                  {panel.name}
                </button>
              ))}
            </div>
            <div className="panel-content">
              <ActiveComponent agentId="switch-test" />
            </div>
          </div>
        );
      };

      cy.mount(<PanelSwitcher />);

      // Check initial panel
      cy.contains('Hello switch-test!').should('be.visible');

      // Switch to second panel
      cy.get('[data-testid="tab-second"]').click();
      cy.contains('Second panel for switch-test').should('be.visible');
      cy.contains('Hello switch-test!').should('not.exist');

      // Switch back
      cy.get('[data-testid="tab-example"]').click();
      cy.contains('Hello switch-test!').should('be.visible');
    });
  });
});
