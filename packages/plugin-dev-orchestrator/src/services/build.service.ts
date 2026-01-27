import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '@elizaos/core';
import type { IBuildSystem, BuildResult } from '../interfaces/IBuildSystem';

const execAsync = promisify(exec);

export class BuildService implements IBuildSystem {
    async detect(projectPath: string): Promise<string | null> {
        // Check for package.json
        const packageJsonPath = join(projectPath, 'package.json');
        if (existsSync(packageJsonPath)) {
            try {
                const packageJson = await import(packageJsonPath, { assert: { type: 'json' } });
                const scripts = packageJson.default?.scripts || packageJson.scripts;
                
                // Check for bun.lockb (bun project)
                if (existsSync(join(projectPath, 'bun.lockb'))) {
                    if (scripts?.build) return 'bun run build';
                    return 'bun install';
                }
                
                // Check for yarn.lock
                if (existsSync(join(projectPath, 'yarn.lock'))) {
                    if (scripts?.build) return 'yarn build';
                    return 'yarn install';
                }
                
                // Check for pnpm-lock.yaml
                if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) {
                    if (scripts?.build) return 'pnpm build';
                    return 'pnpm install';
                }
                
                // Default to npm
                if (scripts?.build) return 'npm run build';
                return 'npm install';
            } catch (error) {
                logger.warn('[BuildService] Failed to parse package.json:', error);
            }
        }

        // Check for Makefile
        if (existsSync(join(projectPath, 'Makefile'))) {
            return 'make';
        }

        // Check for Cargo.toml (Rust)
        if (existsSync(join(projectPath, 'Cargo.toml'))) {
            return 'cargo build';
        }

        // Check for go.mod (Go)
        if (existsSync(join(projectPath, 'go.mod'))) {
            return 'go build';
        }

        logger.warn('[BuildService] Could not detect build system');
        return null;
    }

    async build(projectPath: string, buildCmd?: string): Promise<BuildResult> {
        let command = buildCmd;
        
        if (!command) {
            command = await this.detect(projectPath);
            if (!command) {
                return {
                    success: false,
                    output: '',
                    error: 'Could not detect build system',
                    exitCode: 1,
                };
            }
        }

        logger.info(`[BuildService] Running build: ${command}`);

        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: projectPath,
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer
            });
            
            const output = stdout + (stderr ? `\n${stderr}` : '');
            logger.info('[BuildService] Build succeeded');
            
            return {
                success: true,
                output,
                exitCode: 0,
            };
        } catch (error: any) {
            logger.error('[BuildService] Build failed:', error);
            
            return {
                success: false,
                output: error.stdout || '',
                error: error.stderr || error.message,
                exitCode: error.code || 1,
            };
        }
    }

    async test(projectPath: string, testCmd?: string): Promise<BuildResult> {
        let command = testCmd;
        
        if (!command) {
            // Try to detect test command
            const packageJsonPath = join(projectPath, 'package.json');
            if (existsSync(packageJsonPath)) {
                try {
                    const packageJson = await import(packageJsonPath, { assert: { type: 'json' } });
                    const scripts = packageJson.default?.scripts || packageJson.scripts;
                    
                    if (scripts?.test) {
                        // Check for bun.lockb (bun project)
                        if (existsSync(join(projectPath, 'bun.lockb'))) {
                            command = 'bun test';
                        } else {
                            command = 'npm test';
                        }
                    }
                } catch (error) {
                    logger.warn('[BuildService] Failed to parse package.json:', error);
                }
            }
            
            if (!command) {
                return {
                    success: false,
                    output: '',
                    error: 'Could not detect test command',
                    exitCode: 1,
                };
            }
        }

        logger.info(`[BuildService] Running tests: ${command}`);

        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: projectPath,
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer
            });
            
            const output = stdout + (stderr ? `\n${stderr}` : '');
            logger.info('[BuildService] Tests passed');
            
            return {
                success: true,
                output,
                exitCode: 0,
            };
        } catch (error: any) {
            logger.error('[BuildService] Tests failed:', error);
            
            return {
                success: false,
                output: error.stdout || '',
                error: error.stderr || error.message,
                exitCode: error.code || 1,
            };
        }
    }
}

