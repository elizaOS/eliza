import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    runCliCommandSilently,
    expectCliCommandToFail,
    safeChangeDirectory
} from './test-utils';

describe('ElizaOS Stop Command', () => {
    let testTmpDir: string;
    let elizaosCmd: string;
    let originalCwd: string;

    beforeEach(async () => {
        originalCwd = process.cwd();
        testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-'));

        // Setup elizaos command path for testing
        const cliPath = join(process.cwd(), 'dist', 'index.js');
        elizaosCmd = `bun ${cliPath}`;
    });

    afterEach(async () => {
        safeChangeDirectory(originalCwd);
        if (testTmpDir) {
            try {
                await rm(testTmpDir, { recursive: true });
            } catch (error) {
                console.warn(`Failed to clean up test directory: ${testTmpDir}`);
            }
        }
    });

    describe('stop command help', () => {
        it('should display help information', () => {
            const result = runCliCommandSilently(elizaosCmd, 'stop --help');
            expect(result).toContain('Stop running ElizaOS agents and services');
            expect(result).toContain('--all');
            expect(result).toContain('--agent');
            expect(result).toContain('--force');
            expect(result).toContain('--quiet');
        });
    });

    describe('stop command options', () => {
        it('should accept --all option', () => {
            const result = expectCliCommandToFail(elizaosCmd, 'stop --all --quiet');
            // Should exit with code 2 (no agents running)
            expect(result.status).toBe(2);
        });

        it('should accept --agent option', () => {
            const result = expectCliCommandToFail(elizaosCmd, 'stop --agent test-agent --quiet');
            // Should exit with code 2 (no agents running)
            expect(result.status).toBe(2);
        });

        it('should accept --force option', () => {
            const result = expectCliCommandToFail(elizaosCmd, 'stop --force --quiet');
            // Should exit with code 2 (no agents running)
            expect(result.status).toBe(2);
        });

        it('should accept --quiet option', () => {
            const result = expectCliCommandToFail(elizaosCmd, 'stop --quiet');
            // Should exit with code 2 (no agents running)
            expect(result.status).toBe(2);
        });
    });

    describe('stop command validation', () => {
        it('should handle no running agents gracefully', () => {
            const result = expectCliCommandToFail(elizaosCmd, 'stop --quiet');
            expect(result.status).toBe(2); // Exit code 2: No agents running
        });

        it('should handle invalid agent name', () => {
            const result = expectCliCommandToFail(elizaosCmd, 'stop --agent nonexistent-agent --quiet');
            expect(result.status).toBe(2); // Exit code 2: No agents running
        });

        it('should combine multiple options', () => {
            const result = expectCliCommandToFail(elizaosCmd, 'stop --all --force --quiet');
            expect(result.status).toBe(2); // Exit code 2: No agents running
        });
    });

    describe('stop command integration', () => {
        it('should be registered as a valid command', () => {
            const result = runCliCommandSilently(elizaosCmd, '--help');
            expect(result).toContain('stop');
        });

        it('should have proper command structure', () => {
            const result = runCliCommandSilently(elizaosCmd, 'stop --help');

            // Check that all documented options are present
            expect(result).toContain('--all');
            expect(result).toContain('--agent <name>');
            expect(result).toContain('--force');
            expect(result).toContain('--quiet');
        });
    });
});
