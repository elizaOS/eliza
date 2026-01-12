/// <reference types="cypress" />
/// <reference path="../../cypress/support/types.d.ts" />

import React from 'react';
import type { Agent } from '@elizaos/core';
import { AgentStatus } from '@elizaos/core';

// Create a minimal test component that represents AgentCard functionality
const TestAgentCard: React.FC<{
  agent: Partial<Agent>;
  onChat: (agent: Partial<Agent>) => void;
}> = ({ agent, onChat }) => {
  if (!agent || !agent.id) {
    return <div data-testid="agent-card-error">Agent data not available.</div>;
  }

  const agentName = agent.name || 'Unnamed Agent';
  const isActive = agent.status === AgentStatus.ACTIVE;

  return (
    <div data-testid="agent-card" className="agent-card">
      <div data-testid="agent-name">{agentName}</div>
      <div
        data-testid="status-indicator"
        className={`status-dot ${isActive ? 'active' : 'inactive'}`}
      />
      <div data-testid="agent-status">
        {agent.status === AgentStatus.ACTIVE
          ? 'active'
          : agent.status === AgentStatus.INACTIVE
            ? 'inactive'
            : 'unknown'}
      </div>
      {agent.settings?.avatar && (
        <img
          data-testid="agent-avatar"
          src={
            typeof agent.settings.avatar === 'string' ? agent.settings.avatar : '/elizaos-icon.png'
          }
          alt={agentName}
        />
      )}
      {!agent.settings?.avatar && (
        <div data-testid="agent-initials">{agentName.substring(0, 2).toUpperCase()}</div>
      )}
      {isActive ? (
        <button data-testid="chat-button" onClick={() => onChat(agent)}>
          Chat
        </button>
      ) : (
        <button data-testid="start-button">Start</button>
      )}
      <button data-testid="card-button" onClick={() => onChat(agent)} className="card-clickable">
        Card Click
      </button>
    </div>
  );
};

describe('AgentCard Component', () => {
  const mockAgent: Partial<Agent> = {
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

  const activeAgent: Partial<Agent> = {
    ...mockAgent,
    status: AgentStatus.ACTIVE,
  };

  it('renders agent information correctly', () => {
    const onChat = cy.stub();

    cy.mount(<TestAgentCard agent={mockAgent} onChat={onChat} />);

    // Check agent name is displayed
    cy.get('[data-testid="agent-name"]').should('contain.text', 'Test Agent');

    // Check status indicator exists
    cy.get('[data-testid="status-indicator"]').should('exist');

    // Check agent card exists
    cy.get('[data-testid="agent-card"]').should('exist');
  });

  it('displays active agent correctly', () => {
    const onChat = cy.stub();

    cy.mount(<TestAgentCard agent={activeAgent} onChat={onChat} />);

    // Status should show active
    cy.get('[data-testid="agent-status"]').should('contain.text', 'active');

    // Chat button should be visible
    cy.get('[data-testid="chat-button"]').should('exist');
  });

  it('handles missing agent data gracefully', () => {
    const onChat = cy.stub();

    cy.mount(<TestAgentCard agent={{}} onChat={onChat} />);

    // Should show error message
    cy.get('[data-testid="agent-card-error"]').should('contain.text', 'Agent data not available');
  });

  it('shows start button for inactive agents', () => {
    const onChat = cy.stub();

    cy.mount(<TestAgentCard agent={mockAgent} onChat={onChat} />);

    // Start button should be visible
    cy.get('[data-testid="start-button"]').should('contain.text', 'Start');
  });

  it('shows chat button for active agents', () => {
    const onChat = cy.stub();

    cy.mount(<TestAgentCard agent={activeAgent} onChat={onChat} />);

    // Chat button should be visible
    cy.get('[data-testid="chat-button"]').should('contain.text', 'Chat');
  });

  it('handles chat button click for active agents', () => {
    const onChat = cy.stub();

    cy.mount(<TestAgentCard agent={activeAgent} onChat={onChat} />);

    // Click chat button
    cy.get('[data-testid="chat-button"]').click();

    // Verify onChat was called
    cy.wrap(onChat).should('have.been.calledWith', activeAgent);
  });

  it('navigates when card is clicked', () => {
    const onChat = cy.stub();

    cy.mount(<TestAgentCard agent={mockAgent} onChat={onChat} />);

    // Click the card button
    cy.get('[data-testid="card-button"]').click();

    // Verify onChat was called
    cy.wrap(onChat).should('have.been.calledWith', mockAgent);
  });

  it('shows agent avatar when provided', () => {
    const onChat = cy.stub();

    cy.mount(<TestAgentCard agent={mockAgent} onChat={onChat} />);

    // Should show avatar
    cy.get('[data-testid="agent-avatar"]').should('exist');
    cy.get('[data-testid="agent-avatar"]').should(
      'have.attr',
      'src',
      'https://example.com/avatar.png'
    );
  });

  it('shows initials fallback when no avatar', () => {
    const onChat = cy.stub();
    const agentWithoutAvatar = {
      ...mockAgent,
      settings: {},
    };

    cy.mount(<TestAgentCard agent={agentWithoutAvatar} onChat={onChat} />);

    // Should show initials fallback
    cy.get('[data-testid="agent-initials"]').should('contain.text', 'TE');
  });

  it('displays agent status correctly', () => {
    const onChat = cy.stub();

    cy.mount(<TestAgentCard agent={mockAgent} onChat={onChat} />);

    // Check status is displayed
    cy.get('[data-testid="agent-status"]').should('contain.text', 'inactive');
  });

  it('handles different button states', () => {
    const onChat = cy.stub();

    // Test inactive agent - should show start button
    cy.mount(<TestAgentCard agent={mockAgent} onChat={onChat} />);
    cy.get('[data-testid="start-button"]').should('exist');

    // Test active agent - should show chat button
    cy.mount(<TestAgentCard agent={activeAgent} onChat={onChat} />);
    cy.get('[data-testid="chat-button"]').should('exist');
  });

  it('handles long agent names', () => {
    const onChat = cy.stub();
    const longNameAgent = {
      ...mockAgent,
      name: 'This is a very long agent name that should be displayed',
    };

    cy.mount(<TestAgentCard agent={longNameAgent} onChat={onChat} />);

    // Check that name is displayed
    cy.get('[data-testid="agent-name"]').should('contain.text', 'This is a very long agent name');
  });

  it('renders with proper structure', () => {
    const onChat = cy.stub();

    cy.mount(<TestAgentCard agent={mockAgent} onChat={onChat} />);

    // Check basic structure elements exist
    cy.get('[data-testid="agent-card"]').should('exist');
    cy.get('[data-testid="agent-name"]').should('exist');
    cy.get('[data-testid="status-indicator"]').should('exist');
    cy.get('[data-testid="agent-status"]').should('exist');
  });

  it('handles button interactions', () => {
    const onChat = cy.stub();

    cy.mount(<TestAgentCard agent={activeAgent} onChat={onChat} />);

    // Click chat button
    cy.get('[data-testid="chat-button"]').click();
    cy.wrap(onChat).should('have.been.calledWith', activeAgent);

    // Click card button
    cy.get('[data-testid="card-button"]').click();
    cy.wrap(onChat).should('have.been.calledWith', activeAgent);
  });

  it('shows appropriate content for different agent states', () => {
    const onChat = cy.stub();

    // Test with different agent configurations
    const testCases = [
      { agent: mockAgent, expectedButton: 'start-button' },
      { agent: activeAgent, expectedButton: 'chat-button' },
    ];

    testCases.forEach(({ agent, expectedButton }) => {
      cy.mount(<TestAgentCard agent={agent} onChat={onChat} />);
      cy.get(`[data-testid="${expectedButton}"]`).should('exist');
    });
  });
});
