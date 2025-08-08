import { EnvironmentProvider, ExecutionResult } from './providers';
import { Scenario } from './schema';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class LocalEnvironmentProvider implements EnvironmentProvider {
    private tempDir: string | null = null;

    async setup(scenario: Scenario): Promise<void> {
        const tempDirPrefix = path.join(os.tmpdir(), 'eliza-scenario-run-');
        this.tempDir = await fs.mkdtemp(tempDirPrefix);

        const virtualFs = scenario.setup?.virtual_fs;
        if (virtualFs) {
            for (const [filePath, content] of Object.entries(virtualFs)) {
                const fullPath = path.join(this.tempDir, filePath);
                await fs.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.writeFile(fullPath, content);
            }
        }
    }

    private async captureFileSystem(): Promise<Record<string, string>> {
        if (!this.tempDir) {
            return {};
        }

        const files: Record<string, string> = {};

        try {
            // Recursively read all files in the temp directory
            const readDirRecursive = async (dirPath: string, basePath: string = '') => {
                const entries = await fs.readdir(dirPath, { withFileTypes: true });

                for (const entry of entries) {
                    const fullPath = path.join(dirPath, entry.name);
                    const relativePath = path.join(basePath, entry.name);

                    if (entry.isDirectory()) {
                        await readDirRecursive(fullPath, relativePath);
                    } else if (entry.isFile()) {
                        try {
                            const content = await fs.readFile(fullPath, 'utf-8');
                            files[relativePath] = content;
                        } catch (error) {
                            files[relativePath] = '[binary or unreadable]';
                        }
                    }
                }
            };

            await readDirRecursive(this.tempDir);
            return files;
        } catch (error) {
            console.warn('Failed to capture file system state:', error);
            return {};
        }
    }

    async run(scenario: Scenario): Promise<ExecutionResult[]> {
        if (!this.tempDir) {
            throw new Error('Setup must be called before run.');
        }

        const results: ExecutionResult[] = [];
        for (const step of scenario.run) {
            if (step.input) {
                // Handle natural language input via API client
                const { handleNaturalLanguageInteraction } = await import('./runtime-factory');
                const response = await handleNaturalLanguageInteraction(
                    null as any, // We'll create the server in the function
                    'scenario-runner',
                    step.input
                );

                results.push({
                    exitCode: 0,
                    stdout: response,
                    stderr: '',
                    files: await this.captureFileSystem()
                });
            } else if (step.code) {
                // Construct appropriate command based on language
                let command: string;
                const escapedCode = step.code.replace(/"/g, '\\"');

                switch (step.lang) {
                    case 'bash':
                    case 'sh':
                        command = step.code;
                        break;
                    case 'node':
                    case 'javascript':
                        command = `node -e "${escapedCode}"`;
                        break;
                    case 'python':
                    case 'python3':
                        command = `${step.lang} -c "${escapedCode}"`;
                        break;
                    default:
                        // For other languages, try the -c flag pattern
                        command = `${step.lang} -c "${escapedCode}"`;
                        break;
                }

                try {
                    const { stdout, stderr } = await execAsync(command, { cwd: this.tempDir });

                    // Capture file system state after this step
                    const files = await this.captureFileSystem();

                    results.push({ exitCode: 0, stdout, stderr, files });
                } catch (error: any) {
                    // Capture file system state even on error
                    const files = await this.captureFileSystem();

                    results.push({
                        exitCode: error.code || 1,
                        stdout: error.stdout || '',
                        stderr: error.stderr || error.message || '',
                        files: files
                    });
                }
            } else {
                throw new Error('Step must have either input or code');
            }
        }
        return results;
    }

    async teardown(): Promise<void> {
        if (this.tempDir) {
            await fs.rm(this.tempDir, { recursive: true, force: true });
            this.tempDir = null;
        }
    }
}