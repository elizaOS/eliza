import { EnvironmentProvider, ExecutionResult } from './providers';
import { Scenario } from './schema';
import { AgentRuntime } from '@elizaos/core';

export class E2BEnvironmentProvider implements EnvironmentProvider {
  private runtime: AgentRuntime;
  private e2bService: any; // Use existing service from plugin
  private sandboxId: string | null = null;

  constructor(runtime: AgentRuntime) {
    this.runtime = runtime;
    this.e2bService = runtime.getService('e2b');
    
    if (!this.e2bService) {
      throw new Error(
        "E2B service not found. Please ensure @elizaos/plugin-e2b is properly configured."
      );
    }
  }

  async setup(scenario: Scenario): Promise<void> {
    // Use existing E2B service methods
    this.sandboxId = await this.e2bService.createSandbox({
      timeoutMs: 300000, // 5 minutes default
      metadata: {
        purpose: 'scenario-execution',
        scenarioName: scenario.name
      }
    });
    
    const virtualFs = scenario.setup?.virtual_fs;
    if (virtualFs && this.sandboxId) {
      for (const [filePath, content] of Object.entries(virtualFs)) {
        await this.e2bService.writeFileToSandbox(this.sandboxId, filePath, content);
      }
    }
  }

  async run(scenario: Scenario): Promise<ExecutionResult[]> {
    if (!this.sandboxId) {
      throw new Error('E2B sandbox not initialized');
    }

    const results: ExecutionResult[] = [];
    for (const step of scenario.run) {
      const result = await this.e2bService.runCommand(this.sandboxId, step.input);
      results.push({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    return results;
  }

  async teardown(): Promise<void> {
    if (this.sandboxId) {
      await this.e2bService.killSandbox(this.sandboxId);
      this.sandboxId = null;
    }
  }
} 