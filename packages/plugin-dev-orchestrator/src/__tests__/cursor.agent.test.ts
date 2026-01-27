import { describe, it, expect } from 'vitest';
import { CursorAgent } from '../services/agents/cursor.agent';

describe('CursorAgent', () => {
    it('should create an instance', () => {
        const agent = new CursorAgent();
        expect(agent).toBeDefined();
    });

    it('should have correct name', () => {
        const agent = new CursorAgent();
        expect(agent.getName()).toBe('cursor');
    });

    it('should have execute method', () => {
        const agent = new CursorAgent();
        expect(typeof agent.execute).toBe('function');
    });

    it('should have fixError method', () => {
        const agent = new CursorAgent();
        expect(typeof agent.fixError).toBe('function');
    });
});

