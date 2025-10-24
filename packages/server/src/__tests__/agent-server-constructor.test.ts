/**
 * Constructor tests for AgentServer
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { AgentServer } from '../index';

describe('AgentServer Constructor Tests', () => {
  let server: AgentServer;

  afterEach(() => {
    // Clean up if needed
    if (server) {
      server = null as any;
    }
  });

  it('should create an instance with default properties', () => {
    server = new AgentServer();

    expect(server).toBeDefined();
    expect(server).toBeInstanceOf(AgentServer);
    expect(server.getAllAgents).toBeDefined();
    expect(server.getAllAgents().length).toBe(0);
    expect(server.isInitialized).toBe(false);
  });

  it('should have character loading functions', () => {
    server = new AgentServer();

    expect(server.loadCharacterTryPath).toBeDefined();
    expect(typeof server.loadCharacterTryPath).toBe('function');
    expect(server.jsonToCharacter).toBeDefined();
    expect(typeof server.jsonToCharacter).toBe('function');
  });

  it('should have elizaOS property undefined before initialization', () => {
    server = new AgentServer();

    expect(server.elizaOS).toBeUndefined();
  });

  it('should have all required methods', () => {
    server = new AgentServer();

    const requiredMethods = [
      'initialize',
      'startAgents',
      'stopAgents',
      'getAgent',
      'getAllAgents',
      'registerAgent',
      'stop',
    ];

    for (const method of requiredMethods) {
      expect(server[method]).toBeDefined();
      expect(typeof server[method]).toBe('function');
    }
  });
});
