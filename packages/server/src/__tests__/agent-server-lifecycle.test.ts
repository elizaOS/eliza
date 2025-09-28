/**
 * Lifecycle tests for AgentServer
 * Testing start/stop operations without heavy mocks
 */

import { describe, it, expect } from 'bun:test';
import { AgentServer } from '../index';

describe('AgentServer Lifecycle Tests', () => {
  it('should have stop method', () => {
    const server = new AgentServer();
    expect(typeof server.stop).toBe('function');
  });

  it('should track initialization state', () => {
    const server = new AgentServer();
    expect(server.isInitialized).toBe(false);
    // We can't test actual initialization without mocks,
    // but we can verify the property exists
  });

  it('should have required lifecycle methods', () => {
    const server = new AgentServer();

    // Check all lifecycle methods exist
    expect(typeof server.initialize).toBe('function');
    expect(typeof server.stop).toBe('function');
    expect(typeof server.startAgents).toBe('function');
    expect(typeof server.stopAgents).toBe('function');
  });

  it('should start with empty agents list', () => {
    const server = new AgentServer();
    expect(server.getAllAgents().length).toBe(0);
  });
});
