import { describe, expect, test, beforeEach } from 'bun:test';
import { AgentRegistry, registerAgentWithDetection } from '../services/agent-registry.service';
import { ClaudeCodeAgent } from '../services/agents/claude-code.agent';
import { CursorAgent } from '../services/agents/cursor.agent';

describe('AgentRegistry', () => {
    let registry: AgentRegistry;

    beforeEach(() => {
        // Get fresh registry instance and clear it
        registry = AgentRegistry.getInstance();
        registry.clear();
    });

    test('should be a singleton', () => {
        const instance1 = AgentRegistry.getInstance();
        const instance2 = AgentRegistry.getInstance();
        expect(instance1).toBe(instance2);
    });

    test('should register agents manually', () => {
        registry.register('test-agent', {
            agent: new ClaudeCodeAgent(),
            displayName: 'Test Agent',
            cliCommand: 'test',
            isStable: true,
            isRecommended: false,
            isAvailable: true,
            aliases: ['test', 'testing'],
        });

        expect(registry.has('test-agent')).toBe(true);
        expect(registry.count()).toBe(1);
    });

    test('should parse agent from user input - basic patterns', () => {
        // Register test agents
        registry.register('claude-code', {
            agent: new ClaudeCodeAgent(),
            displayName: 'Claude Code',
            cliCommand: 'claude',
            isStable: true,
            isRecommended: true,
            isAvailable: true,
            aliases: ['claude', 'claude-code', 'claudecode'],
        });

        registry.register('cursor', {
            agent: new CursorAgent(),
            displayName: 'Cursor',
            cliCommand: 'cursor',
            isStable: false,
            isRecommended: false,
            isAvailable: true,
            aliases: ['cursor', 'cursor-ai'],
        });

        // Test various patterns
        expect(registry.parseAgentFromInput('Fix the bug using cursor')).toBe('cursor');
        expect(registry.parseAgentFromInput('Add tests with claude')).toBe('claude-code');
        expect(registry.parseAgentFromInput('Refactor via cursor-ai')).toBe('cursor');
        expect(registry.parseAgentFromInput('Update on claude-code')).toBe('claude-code');
        expect(registry.parseAgentFromInput('Fix in claudecode')).toBe('claude-code');
    });

    test('should parse agent from user input - case insensitive', () => {
        registry.register('claude-code', {
            agent: new ClaudeCodeAgent(),
            displayName: 'Claude Code',
            cliCommand: 'claude',
            isStable: true,
            isRecommended: true,
            isAvailable: true,
            aliases: ['claude', 'CLAUDE-CODE'],
        });

        expect(registry.parseAgentFromInput('Fix using CURSOR')).toBe(null);
        expect(registry.parseAgentFromInput('Fix using CLAUDE')).toBe('claude-code');
        expect(registry.parseAgentFromInput('Fix using Claude-Code')).toBe('claude-code');
    });

    test('should return null when no agent matches', () => {
        registry.register('claude-code', {
            agent: new ClaudeCodeAgent(),
            displayName: 'Claude Code',
            cliCommand: 'claude',
            isStable: true,
            isRecommended: true,
            isAvailable: true,
            aliases: ['claude'],
        });

        expect(registry.parseAgentFromInput('Fix the bug')).toBe(null);
        expect(registry.parseAgentFromInput('Refactor the code')).toBe(null);
        expect(registry.parseAgentFromInput('using unknown-agent')).toBe(null);
    });

    test('should get recommended agent', () => {
        registry.register('cursor', {
            agent: new CursorAgent(),
            displayName: 'Cursor',
            cliCommand: 'cursor',
            isStable: false,
            isRecommended: false,
            isAvailable: true,
        });

        registry.register('claude-code', {
            agent: new ClaudeCodeAgent(),
            displayName: 'Claude Code',
            cliCommand: 'claude',
            isStable: true,
            isRecommended: true,
            isAvailable: true,
        });

        const recommended = registry.getRecommended();
        expect(recommended).not.toBe(null);
        expect(recommended?.name).toBe('claude-code');
    });

    test('should filter available agents', () => {
        registry.register('available', {
            agent: new ClaudeCodeAgent(),
            displayName: 'Available',
            cliCommand: 'test1',
            isStable: true,
            isRecommended: false,
            isAvailable: true,
        });

        registry.register('unavailable', {
            agent: new CursorAgent(),
            displayName: 'Unavailable',
            cliCommand: 'test2',
            isStable: true,
            isRecommended: false,
            isAvailable: false,
        });

        const available = registry.getAvailable();
        expect(available.size).toBe(1);
        expect(available.has('available')).toBe(true);
        expect(available.has('unavailable')).toBe(false);
    });

    test('should sort agents by priority', () => {
        registry.register('unstable', {
            agent: new ClaudeCodeAgent(),
            displayName: 'Unstable',
            cliCommand: 'test1',
            isStable: false,
            isRecommended: false,
            isAvailable: true,
        });

        registry.register('recommended', {
            agent: new ClaudeCodeAgent(),
            displayName: 'Recommended',
            cliCommand: 'test2',
            isStable: true,
            isRecommended: true,
            isAvailable: true,
        });

        registry.register('stable', {
            agent: new ClaudeCodeAgent(),
            displayName: 'Stable',
            cliCommand: 'test3',
            isStable: true,
            isRecommended: false,
            isAvailable: true,
        });

        const sorted = registry.getSortedNames();
        expect(sorted[0]).toBe('recommended');
        expect(sorted[1]).toBe('stable');
        expect(sorted[2]).toBe('unstable');
    });

    test('should get registry status', () => {
        registry.register('agent1', {
            agent: new ClaudeCodeAgent(),
            displayName: 'Agent 1',
            cliCommand: 'test1',
            isStable: true,
            isRecommended: true,
            isAvailable: true,
        });

        registry.register('agent2', {
            agent: new CursorAgent(),
            displayName: 'Agent 2',
            cliCommand: 'test2',
            isStable: false,
            isRecommended: false,
            isAvailable: false,
        });

        const status = registry.getStatus();
        expect(status.total).toBe(2);
        expect(status.available).toBe(1);
        expect(status.stable).toBe(1);
        expect(status.recommended).toBe('agent1');
    });
});
