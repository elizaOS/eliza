/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import AgentCard from './agent-card';
import type { AgentWithStatus } from '@/types';
import { AgentStatus } from '@elizaos/core';

describe('AgentCard Component', () => {
  const mockAgent: Partial<AgentWithStatus> = {
    id: '12345678-1234-1234-1234-123456789012',
    name: 'Test Agent',
    username: 'testagent',
    status: AgentStatus.INACTIVE,
    settings: {
      avatar: 'https://example.com/avatar.png',
    },
    bio: 'Test agent bio',
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const activeAgent: Partial<AgentWithStatus> = {
    ...mockAgent,
    status: AgentStatus.ACTIVE,
  };

  it('renders agent information correctly', () => {
    const onChat = cy.stub();

    cy.mount(<AgentCard agent={mockAgent} onChat={onChat} />);

    // Check agent name is displayed
    cy.contains(mockAgent.name!).should('be.visible');

    // Check status indicator
    cy.get('.rounded-full').should('have.class', 'bg-red-500'); // Inactive = red

    // Check avatar
    cy.get('img[alt="Test Agent"]').should('exist');
  });

  it('displays active agent correctly', () => {
    const onChat = cy.stub();

    cy.mount(<AgentCard agent={activeAgent} onChat={onChat} />);

    // Status should be green for active
    cy.get('.rounded-full').should('have.class', 'bg-green-500');

    // Chat button should be visible
    cy.get('button').contains('svg').parent().should('exist');
  });

  it('handles missing agent data gracefully', () => {
    const onChat = cy.stub();

    cy.mount(<AgentCard agent={{}} onChat={onChat} />);

    // Should show error message
    cy.contains('Agent data not available').should('be.visible');
  });

  it('shows start button for inactive agents', () => {
    const onChat = cy.stub();

    cy.mount(<AgentCard agent={mockAgent} onChat={onChat} />);

    // Start button should be visible
    cy.contains('Start').should('be.visible');
  });

  it('shows stop button for active agents', () => {
    const onChat = cy.stub();

    cy.mount(<AgentCard agent={activeAgent} onChat={onChat} />);

    // Stop button (PowerOff icon) should be visible in tooltip
    cy.get('[data-slot="button"]').first().trigger('mouseenter');
    cy.contains('Stop Agent').should('be.visible');
  });

  it('handles chat button click for active agents', () => {
    const onChat = cy.stub();

    cy.mount(<AgentCard agent={activeAgent} onChat={onChat} />);

    // Click the chat button
    cy.get('button svg').parent().click();

    // onChat should be called
    cy.wrap(onChat).should('have.been.calledWith', activeAgent);
  });

  it('navigates to chat page when inactive agent card is clicked', () => {
    const onChat = cy.stub();

    cy.mount(<AgentCard agent={mockAgent} onChat={onChat} />);

    // Click the card
    cy.get('.cursor-pointer').click();

    // Should navigate (in real app, this would change the route)
    // Since we're in component test, we can't test actual navigation
  });

  it('shows loading state when starting', () => {
    const onChat = cy.stub();
    const startingAgent = {
      ...mockAgent,
      isStarting: true,
    };

    cy.mount(<AgentCard agent={startingAgent} onChat={onChat} />);

    // Should show starting text
    cy.contains('Starting...').should('be.visible');
  });

  it('shows loading state when stopping', () => {
    const onChat = cy.stub();
    const stoppingAgent = {
      ...activeAgent,
      isStopping: true,
    };

    cy.mount(<AgentCard agent={stoppingAgent} onChat={onChat} />);

    // Should show stopping text
    cy.contains('Stopping...').should('be.visible');
  });

  it('displays fallback when no avatar', () => {
    const onChat = cy.stub();
    const agentWithoutAvatar = {
      ...mockAgent,
      settings: {},
    };

    cy.mount(<AgentCard agent={agentWithoutAvatar} onChat={onChat} />);

    // Should show initials or fallback
    cy.get('.bg-secondary').should('exist');
  });

  it('applies correct styling for inactive agents', () => {
    const onChat = cy.stub();

    cy.mount(<AgentCard agent={mockAgent} onChat={onChat} />);

    // Card should have opacity styling
    cy.get('.opacity-75').should('exist');
  });

  it('disables buttons during loading states', () => {
    const onChat = cy.stub();

    // Test starting state
    cy.mount(
      <div data-testid="starting-wrapper">
        <AgentCard agent={{ ...mockAgent, isStarting: true }} onChat={onChat} />
      </div>
    );

    cy.get('[data-testid="starting-wrapper"] button').should('be.disabled');

    // Test stopping state
    cy.mount(
      <div data-testid="stopping-wrapper">
        <AgentCard agent={{ ...activeAgent, isStopping: true }} onChat={onChat} />
      </div>
    );

    cy.get('[data-testid="stopping-wrapper"] button').should('be.disabled');
  });

  it('handles hover effects correctly', () => {
    const onChat = cy.stub();

    cy.mount(<AgentCard agent={mockAgent} onChat={onChat} />);

    // Hover over card
    cy.get('.cursor-pointer').trigger('mouseenter');

    // Should have hover shadow class
    cy.get('.hover\\:shadow-xl').should('exist');
  });

  it('truncates long agent names', () => {
    const onChat = cy.stub();
    const longNameAgent = {
      ...mockAgent,
      name: 'This is a very long agent name that should be truncated',
    };

    cy.mount(<AgentCard agent={longNameAgent} onChat={onChat} />);

    // Check for truncate class
    cy.get('.truncate').should('exist');

    // Title attribute should have full name
    cy.get('[title="This is a very long agent name that should be truncated"]').should('exist');
  });

  it('stops event propagation on button clicks', () => {
    const onChat = cy.stub();
    const cardClick = cy.stub();

    cy.mount(
      <div onClick={cardClick}>
        <AgentCard agent={activeAgent} onChat={onChat} />
      </div>
    );

    // Click stop button
    cy.get('[data-slot="button"]').first().click();

    // Card click should not be triggered
    cy.wrap(cardClick).should('not.have.been.called');
  });
});
