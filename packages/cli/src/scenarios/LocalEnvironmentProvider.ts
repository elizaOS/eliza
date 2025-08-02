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

    async run(scenario: Scenario): Promise<ExecutionResult[]> {
        if (!this.tempDir) {
            throw new Error('Setup must be called before run.');
        }

        const results: ExecutionResult[] = [];
        for (const step of scenario.run) {
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
                results.push({ exitCode: 0, stdout, stderr });
            } catch (error: any) {
                results.push({
                    exitCode: error.code || 1,
                    stdout: error.stdout || '',
                    stderr: error.stderr || error.message || '',
                });
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