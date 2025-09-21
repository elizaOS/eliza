import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Test the recursion prevention logic from startClientDevServer
 */
describe('Dev Server Recursion Prevention', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = join(tmpdir(), `eliza-recursion-test-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    it('should detect recursive elizaos dev in dev script', () => {
        // Create package.json with recursive dev script
        const packageJson = {
            scripts: {
                dev: 'elizaos dev'
            }
        };
        writeFileSync(join(testDir, 'package.json'), JSON.stringify(packageJson, null, 2));
        writeFileSync(join(testDir, 'vite.config.ts'), 'export default {}');

        // Simulate the logic from startClientDevServer
        const shouldSkip = (() => {
            const packageJsonPath = join(testDir, 'package.json');
            if (existsSync(packageJsonPath)) {
                try {
                    const pkg = JSON.parse(require('fs').readFileSync(packageJsonPath, 'utf-8'));
                    const devScript = pkg.scripts?.['dev:client'] || pkg.scripts?.['dev'];

                    // If the dev script would run elizaos dev, skip to prevent recursion
                    if (devScript && devScript.includes('elizaos dev')) {
                        return true; // Should skip
                    }
                } catch (error) {
                    return true; // Should skip on error
                }
            }
            return false;
        })();

        expect(shouldSkip).toBe(true);
    });

    it('should allow safe dev scripts', () => {
        // Create package.json with safe dev script
        const packageJson = {
            scripts: {
                dev: 'vite'
            }
        };
        writeFileSync(join(testDir, 'package.json'), JSON.stringify(packageJson, null, 2));
        writeFileSync(join(testDir, 'vite.config.ts'), 'export default {}');

        // Simulate the logic from startClientDevServer
        const shouldSkip = (() => {
            const packageJsonPath = join(testDir, 'package.json');
            if (existsSync(packageJsonPath)) {
                try {
                    const pkg = JSON.parse(require('fs').readFileSync(packageJsonPath, 'utf-8'));
                    const devScript = pkg.scripts?.['dev:client'] || pkg.scripts?.['dev'];

                    // If the dev script would run elizaos dev, skip to prevent recursion
                    if (devScript && devScript.includes('elizaos dev')) {
                        return true; // Should skip
                    }
                } catch (error) {
                    return true; // Should skip on error
                }
            }
            return false;
        })();

        expect(shouldSkip).toBe(false);
    });

    it('should prefer dev:client over dev script', () => {
        // Create package.json with both scripts
        const packageJson = {
            scripts: {
                'dev:client': 'vite --port 5173',
                dev: 'elizaos dev'
            }
        };
        writeFileSync(join(testDir, 'package.json'), JSON.stringify(packageJson, null, 2));
        writeFileSync(join(testDir, 'vite.config.ts'), 'export default {}');

        // Simulate the logic from startClientDevServer
        const shouldSkip = (() => {
            const packageJsonPath = join(testDir, 'package.json');
            if (existsSync(packageJsonPath)) {
                try {
                    const pkg = JSON.parse(require('fs').readFileSync(packageJsonPath, 'utf-8'));
                    const devScript = pkg.scripts?.['dev:client'] || pkg.scripts?.['dev'];

                    // If the dev script would run elizaos dev, skip to prevent recursion
                    if (devScript && devScript.includes('elizaos dev')) {
                        return true; // Should skip
                    }
                } catch (error) {
                    return true; // Should skip on error
                }
            }
            return false;
        })();

        expect(shouldSkip).toBe(false); // Should not skip because dev:client is safe
    });

    it('should skip on malformed package.json', () => {
        // Create malformed package.json
        writeFileSync(join(testDir, 'package.json'), '{ invalid json }');
        writeFileSync(join(testDir, 'vite.config.ts'), 'export default {}');

        // Simulate the logic from startClientDevServer
        const shouldSkip = (() => {
            const packageJsonPath = join(testDir, 'package.json');
            if (existsSync(packageJsonPath)) {
                try {
                    const pkg = JSON.parse(require('fs').readFileSync(packageJsonPath, 'utf-8'));
                    const devScript = pkg.scripts?.['dev:client'] || pkg.scripts?.['dev'];

                    // If the dev script would run elizaos dev, skip to prevent recursion
                    if (devScript && devScript.includes('elizaos dev')) {
                        return true; // Should skip
                    }
                } catch (error) {
                    return true; // Should skip on error
                }
            }
            return false;
        })();

        expect(shouldSkip).toBe(true); // Should skip due to parse error
    });
});
