import React from 'react';
import { panels } from '../../../frontend/index';

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

      // Note: The component has a typo "Helllo" instead of "Hello"
      cy.contains(`Helllo ${testAgentId}!`).should('be.visible');
    });

    it('should handle different agent IDs', () => {
      const agentIds = ['agent-1', 'agent-2', '12345678-1234-1234-1234-123456789abc', 'test-agent'];

      agentIds.forEach((agentId) => {
        cy.mount(<PanelComponent agentId={agentId} />);
        cy.contains(`Helllo ${agentId}!`).should('be.visible');
      });
    });

    it('should render without crashing with empty agent ID', () => {
      cy.mount(<PanelComponent agentId="" />);
      cy.contains('Helllo !').should('be.visible');
    });
  });
});
