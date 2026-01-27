import { describe, it, expect } from 'vitest';
import { devOrchestratorPlugin } from '../index';

describe('Dev Orchestrator Plugin', () => {
    it('should have correct plugin metadata', () => {
        expect(devOrchestratorPlugin.name).toBe('dev-orchestrator');
        expect(devOrchestratorPlugin.description).toBeTruthy();
    });

    it('should export DevOrchestratorService', () => {
        expect(devOrchestratorPlugin.services).toBeDefined();
        expect(devOrchestratorPlugin.services?.length).toBeGreaterThan(0);
    });

    it('should have dev orchestrator actions', () => {
        expect(devOrchestratorPlugin.actions).toBeDefined();
        expect(devOrchestratorPlugin.actions?.length).toBeGreaterThan(0);
        
        const actionNames = devOrchestratorPlugin.actions?.map(a => a.name) || [];
        expect(actionNames).toContain('SUBMIT_CODE_TASK');
        expect(actionNames).toContain('QUEUE_STATUS');
        expect(actionNames).toContain('APPROVE_TASK');
        expect(actionNames).toContain('REJECT_TASK');
        expect(actionNames).toContain('ROLLBACK_CHANGES');
    });
});

