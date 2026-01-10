import {
  type IAgentRuntime,
  Service,
  logger,
} from '@elizaos/core';
import spawn from 'cross-spawn';
import path from 'path';
import { loadShellConfig, type ShellConfig } from '../environment';
import {
  validatePath,
  isSafeCommand,
  isForbiddenCommand,
} from '../utils/pathUtils';

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  executedIn: string;
}

export interface CommandHistoryEntry {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timestamp: number;
  workingDirectory: string;
  fileOperations?: FileOperation[];
}

export interface FileOperation {
  type: 'create' | 'write' | 'read' | 'delete' | 'mkdir' | 'move' | 'copy';
  target: string;
  secondaryTarget?: string; // For move/copy operations
}

export class ShellService extends Service {
  public static serviceType = 'shell';
  private shellConfig: ShellConfig;
  private currentDirectory: string;
  private commandHistory: Map<string, CommandHistoryEntry[]>; // conversationId -> history
  private maxHistoryPerConversation = 100;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    this.shellConfig = loadShellConfig();
    this.currentDirectory = this.shellConfig.allowedDirectory;
    this.commandHistory = new Map();
  }

  static async start(runtime: IAgentRuntime): Promise<ShellService> {
    const instance = new ShellService(runtime);
    logger.info('Shell service initialized with history tracking');
    return instance;
  }

  async stop(): Promise<void> {
    // Cleanup if needed
    logger.info('Shell service stopped');
  }

  get capabilityDescription(): string {
    return 'Execute shell commands within a restricted directory with history tracking';
  }

  /**
   * Executes a shell command within the allowed directory
   * @param command The command to execute
   * @param conversationId Optional conversation ID for history tracking
   * @returns The command execution result
   */
  async executeCommand(command: string, conversationId?: string): Promise<CommandResult> {
    // Check if shell is enabled
    if (!this.shellConfig.enabled) {
      return {
        success: false,
        stdout: '',
        stderr: 'Shell plugin is disabled. Set SHELL_ENABLED=true to enable.',
        exitCode: 1,
        error: 'Shell plugin disabled',
        executedIn: this.currentDirectory,
      };
    }

    // Basic command validation
    if (!command || typeof command !== 'string') {
      return {
        success: false,
        stdout: '',
        stderr: 'Invalid command',
        exitCode: 1,
        error: 'Command must be a non-empty string',
        executedIn: this.currentDirectory,
      };
    }

    const trimmedCommand = command.trim();

    // Check for dangerous patterns
    if (!isSafeCommand(trimmedCommand)) {
      return {
        success: false,
        stdout: '',
        stderr: 'Command contains forbidden patterns',
        exitCode: 1,
        error: 'Security policy violation',
        executedIn: this.currentDirectory,
      };
    }

    // Check for forbidden commands
    if (isForbiddenCommand(trimmedCommand, this.shellConfig.forbiddenCommands)) {
      return {
        success: false,
        stdout: '',
        stderr: `Command is forbidden by security policy`,
        exitCode: 1,
        error: 'Forbidden command',
        executedIn: this.currentDirectory,
      };
    }

    // Handle cd command specially to track directory changes
    if (trimmedCommand.startsWith('cd ')) {
      const result = await this.handleCdCommand(trimmedCommand);
      this.addToHistory(conversationId, trimmedCommand, result);
      return result;
    }

    // Execute the command
    const result = await this.runCommand(trimmedCommand);
    
    // Track file operations if successful
    if (result.success) {
      const fileOps = this.detectFileOperations(trimmedCommand, this.currentDirectory);
      if (fileOps && conversationId) {
        this.addToHistory(conversationId, trimmedCommand, result, fileOps);
      } else {
        this.addToHistory(conversationId, trimmedCommand, result);
      }
    } else {
      this.addToHistory(conversationId, trimmedCommand, result);
    }
    
    return result;
  }

  /**
   * Handles the cd command to change directory within allowed bounds
   * @param command The cd command
   * @returns The command result
   */
  private async handleCdCommand(command: string): Promise<CommandResult> {
    const parts = command.split(/\s+/);
    if (parts.length < 2) {
      // cd without arguments goes to allowed directory
      this.currentDirectory = this.shellConfig.allowedDirectory;
      return {
        success: true,
        stdout: `Changed directory to: ${this.currentDirectory}`,
        stderr: '',
        exitCode: 0,
        executedIn: this.currentDirectory,
      };
    }

    const targetPath = parts.slice(1).join(' ');
    const validatedPath = validatePath(
      targetPath,
      this.shellConfig.allowedDirectory,
      this.currentDirectory
    );

    if (!validatedPath) {
      return {
        success: false,
        stdout: '',
        stderr: 'Cannot navigate outside allowed directory',
        exitCode: 1,
        error: 'Permission denied',
        executedIn: this.currentDirectory,
      };
    }

    // Update current directory
    this.currentDirectory = validatedPath;
    return {
      success: true,
      stdout: `Changed directory to: ${this.currentDirectory}`,
      stderr: '',
      exitCode: 0,
      executedIn: this.currentDirectory,
    };
  }

  /**
   * Runs a command using cross-spawn
   * @param command The command to run
   * @returns The command result
   */
  private async runCommand(command: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      // For complex commands with redirects or quotes, we need to use shell
      const useShell = command.includes('>') || command.includes('<') || command.includes('|');
      
      let cmd: string;
      let args: string[];
      
      if (useShell) {
        // Use sh -c for commands with redirects/pipes
        cmd = 'sh';
        args = ['-c', command];
        logger.info(`Executing shell command: sh -c "${command}" in ${this.currentDirectory}`);
      } else {
        // For simple commands, split and execute directly
        const parts = command.split(/\s+/);
        cmd = parts[0];
        args = parts.slice(1);
        logger.info(`Executing command: ${cmd} ${args.join(' ')} in ${this.currentDirectory}`);
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Spawn the process
      const child = spawn(cmd, args, {
        cwd: this.currentDirectory,
        env: process.env,
        // Only use shell: false for direct commands, not for sh -c
        shell: false,
      });

      // Set timeout
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Force kill after 5 seconds if process doesn't terminate
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }, this.shellConfig.timeout);

      // Capture stdout
      if (child.stdout) {
        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
      }

      // Capture stderr
      if (child.stderr) {
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }

      // Handle process exit
      child.on('exit', (code) => {
        clearTimeout(timeout);

        if (timedOut) {
          resolve({
            success: false,
            stdout,
            stderr: stderr + '\nCommand timed out',
            exitCode: code,
            error: 'Command execution timeout',
            executedIn: this.currentDirectory,
          });
          return;
        }

        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code,
          executedIn: this.currentDirectory,
        });
      });

      // Handle spawn errors
      child.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          stdout,
          stderr: err.message,
          exitCode: 1,
          error: 'Failed to execute command',
          executedIn: this.currentDirectory,
        });
      });
    });
  }

  /**
   * Adds a command to the history
   */
  private addToHistory(
    conversationId: string | undefined, 
    command: string, 
    result: CommandResult,
    fileOperations?: FileOperation[]
  ): void {
    if (!conversationId) return;

    const historyEntry: CommandHistoryEntry = {
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timestamp: Date.now(),
      workingDirectory: result.executedIn,
      fileOperations
    };

    if (!this.commandHistory.has(conversationId)) {
      this.commandHistory.set(conversationId, []);
    }

    const history = this.commandHistory.get(conversationId)!;
    history.push(historyEntry);

    // Trim history if it exceeds max length
    if (history.length > this.maxHistoryPerConversation) {
      history.shift();
    }
  }

  /**
   * Detects file operations from a command
   */
  private detectFileOperations(command: string, cwd: string): FileOperation[] | undefined {
    const operations: FileOperation[] = [];
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    // File creation/writing
    if (cmd === 'touch' && parts.length > 1) {
      operations.push({
        type: 'create',
        target: this.resolvePath(parts[1], cwd)
      });
    } else if (cmd === 'echo' && command.includes('>')) {
      const match = command.match(/>\s*([^\s]+)$/);
      if (match) {
        operations.push({
          type: 'write',
          target: this.resolvePath(match[1], cwd)
        });
      }
    } else if (cmd === 'mkdir' && parts.length > 1) {
      operations.push({
        type: 'mkdir',
        target: this.resolvePath(parts[1], cwd)
      });
    } else if (cmd === 'cat' && parts.length > 1 && !command.includes('>')) {
      operations.push({
        type: 'read',
        target: this.resolvePath(parts[1], cwd)
      });
    } else if (cmd === 'mv' && parts.length > 2) {
      operations.push({
        type: 'move',
        target: this.resolvePath(parts[1], cwd),
        secondaryTarget: this.resolvePath(parts[2], cwd)
      });
    } else if (cmd === 'cp' && parts.length > 2) {
      operations.push({
        type: 'copy',
        target: this.resolvePath(parts[1], cwd),
        secondaryTarget: this.resolvePath(parts[2], cwd)
      });
    }

    return operations.length > 0 ? operations : undefined;
  }

  /**
   * Resolves a path relative to the current working directory
   */
  private resolvePath(filePath: string, cwd: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.join(cwd, filePath);
  }

  /**
   * Gets command history for a conversation
   */
  getCommandHistory(conversationId: string, limit?: number): CommandHistoryEntry[] {
    const history = this.commandHistory.get(conversationId) || [];
    if (limit && limit > 0) {
      return history.slice(-limit);
    }
    return history;
  }

  /**
   * Clears command history for a conversation
   */
  clearCommandHistory(conversationId: string): void {
    this.commandHistory.delete(conversationId);
    logger.info(`Cleared command history for conversation: ${conversationId}`);
  }

  /**
   * Gets the current working directory
   * @param conversationId Optional conversation ID to get conversation-specific directory
   * @returns The current directory path
   */
  getCurrentDirectory(_conversationId?: string): string {
    // For now, we use a global current directory
    // Could be enhanced to track per-conversation directories
    return this.currentDirectory;
  }

  /**
   * Gets the allowed directory
   * @returns The allowed directory path
   */
  getAllowedDirectory(): string {
    return this.shellConfig.allowedDirectory;
  }
} 