import { EnvironmentProvider, ExecutionResult } from './providers';
import { Scenario } from './schema';
import { AgentServer } from '@elizaos/server';
import { UUID, AgentRuntime } from '@elizaos/core';
import { askAgentViaApi } from './runtime-factory';
import { TrajectoryReconstructor } from './TrajectoryReconstructor';
import { ConversationManager } from './ConversationManager';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { bunExec } from '../../../utils/bun-exec';

export class LocalEnvironmentProvider implements EnvironmentProvider {
  private tempDir: string | null = null;
  private server: AgentServer | null = null;
  private agentId: UUID | null = null;
  private runtime: AgentRuntime | null = null; // FIXED: needed for ConversationManager
  private serverPort: number | null = null;
  private trajectoryReconstructor: TrajectoryReconstructor | null = null;
  private conversationManager: ConversationManager | null = null;

  constructor(server?: AgentServer, agentId?: UUID, _runtime?: AgentRuntime, serverPort?: number) {
    this.server = server ?? null;
    this.agentId = agentId ?? null;
    this.runtime = _runtime ?? null; // FIXED: needed for ConversationManager
    this.serverPort = serverPort ?? null;
    this.trajectoryReconstructor = _runtime ? new TrajectoryReconstructor(_runtime) : null;

    console.log(`🔧 [DEBUG] LocalEnvironmentProvider CONSTRUCTOR:`);
    console.log(`🔧 [DEBUG]   - Server: ${server ? 'present' : 'null'}`);
    console.log(`🔧 [DEBUG]   - Agent ID: ${agentId}`);
    console.log(`🔧 [DEBUG]   - Runtime: ${_runtime ? 'present' : 'null'}`);
    console.log(`🔧 [DEBUG]   - Server Port: ${serverPort}`);
  }

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
      const startedAtMs = Date.now();

      // NEW: Check if this is a conversation step
      if (step.conversation) {
        if (!this.server || !this.agentId) {
          throw new Error(
            'LocalEnvironmentProvider requires a pre-created server and agent for conversation steps'
          );
        }

        // Initialize conversation manager if needed
        if (!this.conversationManager) {
          this.conversationManager = new ConversationManager(
            this.runtime!,
            this.server,
            this.agentId,
            this.serverPort!,
            this.trajectoryReconstructor!
          );
        }

        console.log(
          `🗣️  [LocalEnvironmentProvider] Executing conversation step: ${step.name || 'unnamed'}`
        );

        const conversationResult = await this.conversationManager.executeConversation(
          step.input || 'Hello, I need help.',
          step.conversation
        );

        // Convert conversation result to ExecutionResult format
        const endedAtMs = Date.now();
        const durationMs = endedAtMs - startedAtMs;

        const executionResult: ExecutionResult = {
          exitCode: conversationResult.success ? 0 : 1,
          stdout: conversationResult.conversationTranscript,
          stderr: conversationResult.success ? '' : 'Conversation failed',
          files: await this.captureFileSystem(),
          startedAtMs,
          endedAtMs,
          durationMs,
          trajectory: conversationResult.turns.flatMap((turn) => turn.trajectory),
        };

        // Add conversation metadata to result for conversation evaluators
        (executionResult as any).conversationMetadata = {
          turnCount: conversationResult.turns.length,
          terminatedEarly: conversationResult.terminatedEarly,
          terminationReason: conversationResult.terminationReason,
          finalEvaluations: conversationResult.finalEvaluations,
        };

        results.push(executionResult);
      } else if (step.input) {
        if (!this.server || !this.agentId) {
          throw new Error(
            'LocalEnvironmentProvider requires a pre-created server and agent for NL input'
          );
        }
        const { response, roomId } = await askAgentViaApi(
          this.server,
          this.agentId,
          step.input,
          90000, // timeout
          this.serverPort // Pass the actual server port
        );

        // Give database time to write logs before reconstructing trajectory
        await new Promise((resolve) => setTimeout(resolve, 3000)); // 3 second delay to allow async DB writes

        // Reconstruct trajectory from database logs (Ticket #5785 - Non-invasive approach)
        const trajectory =
          this.trajectoryReconstructor && roomId
            ? await this.trajectoryReconstructor.getLatestTrajectory(roomId)
            : [];

        // Debug trajectory reconstruction
        console.log(`🔍 [Trajectory Debug] Room ID: ${roomId}, Steps found: ${trajectory.length}`);
        if (trajectory.length > 0) {
          console.log(`📊 [Trajectory Debug] First step:`, JSON.stringify(trajectory[0], null, 2));
        }

        const endedAtMs = Date.now();
        const durationMs = endedAtMs - startedAtMs;

        results.push({
          exitCode: 0,
          stdout: response,
          stderr: '',
          files: await this.captureFileSystem(),
          startedAtMs,
          endedAtMs,
          durationMs,
          trajectory, // Add trajectory to execution result
        });
      } else if (step.code) {
        // Construct appropriate command and arguments based on language
        // Use proper argument arrays to prevent command injection
        let execCommand: string;
        let execArgs: string[];

        switch (step.lang) {
          case 'bash':
          case 'sh':
            execCommand = 'sh';
            execArgs = ['-c', step.code];
            break;
          case 'node':
          case 'javascript':
            execCommand = 'node';
            execArgs = ['-e', step.code];
            break;
          case 'python':
          case 'python3':
            execCommand = 'python3';
            execArgs = ['-c', step.code];
            break;
          default:
            // For other languages, try the -c flag pattern
            execCommand = step.lang || 'bash';
            execArgs = ['-c', step.code];
            break;
        }

        try {
          const result = await bunExec(execCommand, execArgs, { cwd: this.tempDir });
          const { stdout, stderr } = result;

          // Capture file system state after this step
          const files = await this.captureFileSystem();

          const endedAtMs = Date.now();
          const durationMs = endedAtMs - startedAtMs;

          results.push({
            exitCode: result.exitCode || 0,
            stdout,
            stderr,
            files,
            startedAtMs,
            endedAtMs,
            durationMs,
          });
        } catch (error: any) {
          // Capture file system state even on error
          const files = await this.captureFileSystem();

          const endedAtMs = Date.now();
          const durationMs = endedAtMs - startedAtMs;

          // Handle different error types from bunExec
          let exitCode = 1;
          let stderr = '';
          let stdout = '';

          if (error.exitCode !== undefined) {
            exitCode = error.exitCode;
          }
          if (error.stderr) {
            stderr = error.stderr;
          }
          if (error.stdout) {
            stdout = error.stdout;
          }
          if (!stderr && error.message) {
            stderr = error.message;
          }

          results.push({
            exitCode,
            stdout,
            stderr,
            files: files,
            startedAtMs,
            endedAtMs,
            durationMs,
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
