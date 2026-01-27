import { describe, it, expect } from 'vitest';
import { GitServiceLegacy } from '../services/git-legacy.service';

describe('GitServiceLegacy', () => {
    it('should create an instance', () => {
        const gitService = new GitServiceLegacy();
        expect(gitService).toBeDefined();
    });

    it('should have all required IVersionControl methods', () => {
        const gitService = new GitServiceLegacy();
        expect(typeof gitService.createSnapshot).toBe('function');
        expect(typeof gitService.restoreSnapshot).toBe('function');
        expect(typeof gitService.getDiff).toBe('function');
        expect(typeof gitService.commit).toBe('function');
        expect(typeof gitService.getCurrentBranch).toBe('function');
        expect(typeof gitService.createBranch).toBe('function');
        expect(typeof gitService.checkoutBranch).toBe('function');
        expect(typeof gitService.mergeBranch).toBe('function');
        expect(typeof gitService.deleteBranch).toBe('function');
        expect(typeof gitService.getRepoRoot).toBe('function');
        expect(typeof gitService.isClean).toBe('function');
    });
});

