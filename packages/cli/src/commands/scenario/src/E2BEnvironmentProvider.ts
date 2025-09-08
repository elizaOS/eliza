import { EnvironmentProvider, ExecutionResult } from './providers';
import { Scenario } from './schema';
import { AgentRuntime, UUID } from '@elizaos/core';
import { AgentServer } from '@elizaos/server';
import { askAgentViaApi } from './runtime-factory';
import { TrajectoryReconstructor } from './TrajectoryReconstructor';

export class E2BEnvironmentProvider implements EnvironmentProvider {
  private runtime: AgentRuntime;
  private sandboxId: string | null = null;
  private server: AgentServer;
  private agentId: UUID;
  private serverPort: number;
  private trajectoryReconstructor: TrajectoryReconstructor;

  constructor(runtime: AgentRuntime, server: AgentServer, agentId: UUID, serverPort: number) {
    this.runtime = runtime;
    this.server = server;
    this.agentId = agentId;
    this.serverPort = serverPort;
    this.trajectoryReconstructor = new TrajectoryReconstructor(runtime);

    // Verify the service exists
    const e2bService = runtime.getService('e2b');
    if (!e2bService) {
      throw new Error(
        'E2B service not found. Please ensure @elizaos/plugin-e2b is properly configured.'
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
        scenarioName: scenario.name,
      },
    });

    // Set up virtual filesystem by writing files using code execution
    const virtualFs = scenario.setup?.virtual_fs;
    if (virtualFs && this.sandboxId) {
      for (const [filePath, content] of Object.entries(virtualFs)) {
        // Validate file path to prevent injection
        if (
          typeof filePath !== 'string' ||
          filePath.includes('..') ||
          filePath.includes('`') ||
          filePath.includes('$')
        ) {
          throw new Error(`Invalid file path: ${filePath}`);
        }

        // Validate content to prevent injection
        if (typeof content !== 'string') {
          throw new Error(`Invalid file content for ${filePath}`);
        }

        // Use safe Python code with escaped strings
        const safeFilePath = JSON.stringify(filePath);
        const safeContent = JSON.stringify(content);
        const writeFileCode = `
import json
file_path = json.loads(${safeFilePath})
content = json.loads(${safeContent})
with open(file_path, "w") as f:
    f.write(content)
print(f"Created file: {file_path}")
`;
        await e2bService.executeCode(writeFileCode, 'python');
      }
    }
  }

  private async captureFileSystem(e2bService: any): Promise<Record<string, string>> {
    // Use Python code to capture all files in the sandbox
    const captureCode = `
import os
import json
files = {}
for root, dirs, files_list in os.walk('.'):
    for file in files_list:
        path = os.path.join(root, file)
        try:
            with open(path, 'r') as f:
                files[path] = f.read()
        except Exception as e:
            files[path] = f"[binary or unreadable: {str(e)}]"
print(json.dumps(files))
`;

    try {
      const result = await e2bService.executeCode(captureCode, 'python');
      const filesJson = result.text || result.logs?.stdout?.join('\n') || '{}';

      // Handle case where the response is not valid JSON (e.g., mock responses)
      if (typeof filesJson === 'string' && filesJson.trim().startsWith('{')) {
        return JSON.parse(filesJson);
      } else {
        // If it's not JSON, return empty files object
        console.warn(
          'File system capture returned non-JSON response, returning empty files object'
        );
        return {};
      }
    } catch (error) {
      console.warn('Failed to capture file system state:', error);
      return {};
    }
  }

  async run(scenario: Scenario): Promise<ExecutionResult[]> {
    const e2bService = this.runtime.getService('e2b') as any;

    // The E2B service manages sandboxes internally, no need to check sandboxId here
    const results: ExecutionResult[] = [];
    for (const step of scenario.run) {
      const startedAtMs = Date.now();

      if (step.input) {
        // Use the existing server + agent to get an NL response
        const { response, roomId } = await askAgentViaApi(
          this.server,
          this.agentId,
          step.input,
          90000, // timeout
          this.serverPort // Pass the actual server port
        );

        // Reconstruct trajectory from database logs (Ticket #5785 - Non-invasive approach)
        const trajectory = await this.trajectoryReconstructor.getLatestTrajectory(roomId);

        const endedAtMs = Date.now();
        const durationMs = endedAtMs - startedAtMs;

        results.push({
          exitCode: 0,
          stdout: response,
          stderr: '',
          files: await this.captureFileSystem(e2bService),
          startedAtMs,
          endedAtMs,
          durationMs,
          trajectory, // Add trajectory to execution result
        });
      } else if (step.code) {
        // Use the correct executeCode API: executeCode(code: string, language?: string)
        const result = await e2bService.executeCode(step.code, step.lang);

        // Capture file system state after this step
        const files = await this.captureFileSystem(e2bService);

        // Map E2B result format to ExecutionResult format
        const endedAtMs = Date.now();
        const durationMs = endedAtMs - startedAtMs;

        results.push({
          exitCode: result.error ? 1 : 0,
          stdout: result.text || result.logs?.stdout?.join('\n') || '',
          stderr: result.error?.value || result.logs?.stderr?.join('\n') || '',
          files: files,
          startedAtMs,
          endedAtMs,
          durationMs,
        });
      } else {
        throw new Error('Step must have either input or code');
      }
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
