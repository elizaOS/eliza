import { EnvironmentProvider, ExecutionResult } from './providers';
import { Scenario } from './schema';
import { AgentRuntime } from '@elizaos/core';

export class E2BEnvironmentProvider implements EnvironmentProvider {
    private runtime: AgentRuntime;
    private sandboxId: string | null = null;

    constructor(runtime: AgentRuntime) {
        this.runtime = runtime;

        // Verify the service exists
        const e2bService = runtime.getService('e2b');
        if (!e2bService) {
            throw new Error(
                "E2B service not found. Please ensure @elizaos/plugin-e2b is properly configured."
            );
        }
    }

    async setup(scenario: Scenario): Promise<void> {
        const e2bService = this.runtime.getService('e2b') as any;

        // Create a sandbox for this scenario execution
        this.sandboxId = await e2bService.createSandbox({
            timeoutMs: 300000, // 5 minutes default
            metadata: {
                purpose: 'scenario-execution',
                scenarioName: scenario.name
            }
        });

        // Set up virtual filesystem by writing files using code execution
        const virtualFs = scenario.setup?.virtual_fs;
        if (virtualFs && this.sandboxId) {
            for (const [filePath, content] of Object.entries(virtualFs)) {
                // Use Python code to write files since the service manages sandboxes internally
                const writeFileCode = `
with open("${filePath}", "w") as f:
    f.write("""${content}""")
print(f"Created file: ${filePath}")
`;
                await e2bService.executeCode(writeFileCode, 'python');
            }
        }
    }

    async run(scenario: Scenario): Promise<ExecutionResult[]> {
        const e2bService = this.runtime.getService('e2b') as any;

        // The E2B service manages sandboxes internally, no need to check sandboxId here
        const results: ExecutionResult[] = [];
        for (const step of scenario.run) {
            console.log('Executing E2B step:', JSON.stringify(step, null, 2));

            // Use the correct executeCode API: executeCode(code: string, language?: string)
            const result = await e2bService.executeCode(step.code, step.lang);

            // Map E2B result format to ExecutionResult format
            results.push({
                exitCode: result.error ? 1 : 0,
                stdout: result.text || result.logs?.stdout?.join('\n') || '',
                stderr: result.error?.value || result.logs?.stderr?.join('\n') || ''
            });
        }
        return results;
    }

    async teardown(): Promise<void> {
        // Clean up the sandbox if we created one explicitly
        if (this.sandboxId) {
            const e2bService = this.runtime.getService('e2b') as any;
            await e2bService.killSandbox(this.sandboxId);
            this.sandboxId = null;
        }
    }
} 