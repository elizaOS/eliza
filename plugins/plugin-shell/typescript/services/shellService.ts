import path from "node:path";
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import spawn from "cross-spawn";
import type {
  CommandHistoryEntry,
  CommandResult,
  FileOperation,
  FileOperationType,
  ShellConfig,
} from "../types";
import { isForbiddenCommand, isSafeCommand, loadShellConfig, validatePath } from "../utils";

export class ShellService extends Service {
  public static serviceType = "shell";
  private shellConfig: ShellConfig;
  private currentDirectory: string;
  private commandHistory: Map<string, CommandHistoryEntry[]>;
  private maxHistoryPerConversation = 100;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.shellConfig = loadShellConfig();
    this.currentDirectory = this.shellConfig.allowedDirectory;
    this.commandHistory = new Map();
  }

  static async start(runtime: IAgentRuntime): Promise<ShellService> {
    const instance = new ShellService(runtime);
    logger.info("Shell service initialized with history tracking");
    return instance;
  }

  async stop(): Promise<void> {
    logger.info("Shell service stopped");
  }

  get capabilityDescription(): string {
    return "Execute shell commands within a restricted directory with history tracking";
  }

  async executeCommand(command: string, conversationId?: string): Promise<CommandResult> {
    if (!this.shellConfig.enabled) {
      return {
        success: false,
        stdout: "",
        stderr: "Shell plugin is disabled. Set SHELL_ENABLED=true to enable.",
        exitCode: 1,
        error: "Shell plugin disabled",
        executedIn: this.currentDirectory,
      };
    }

    if (!command || typeof command !== "string") {
      return {
        success: false,
        stdout: "",
        stderr: "Invalid command",
        exitCode: 1,
        error: "Command must be a non-empty string",
        executedIn: this.currentDirectory,
      };
    }

    const trimmedCommand = command.trim();

    if (!isSafeCommand(trimmedCommand)) {
      return {
        success: false,
        stdout: "",
        stderr: "Command contains forbidden patterns",
        exitCode: 1,
        error: "Security policy violation",
        executedIn: this.currentDirectory,
      };
    }

    if (isForbiddenCommand(trimmedCommand, this.shellConfig.forbiddenCommands)) {
      return {
        success: false,
        stdout: "",
        stderr: "Command is forbidden by security policy",
        exitCode: 1,
        error: "Forbidden command",
        executedIn: this.currentDirectory,
      };
    }

    if (trimmedCommand.startsWith("cd ")) {
      const result = await this.handleCdCommand(trimmedCommand);
      this.addToHistory(conversationId, trimmedCommand, result);
      return result;
    }

    const result = await this.runCommand(trimmedCommand);

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

  private async handleCdCommand(command: string): Promise<CommandResult> {
    const parts = command.split(/\s+/);
    if (parts.length < 2) {
      this.currentDirectory = this.shellConfig.allowedDirectory;
      return {
        success: true,
        stdout: `Changed directory to: ${this.currentDirectory}`,
        stderr: "",
        exitCode: 0,
        executedIn: this.currentDirectory,
      };
    }

    const targetPath = parts.slice(1).join(" ");
    const validatedPath = validatePath(
      targetPath,
      this.shellConfig.allowedDirectory,
      this.currentDirectory
    );

    if (!validatedPath) {
      return {
        success: false,
        stdout: "",
        stderr: "Cannot navigate outside allowed directory",
        exitCode: 1,
        error: "Permission denied",
        executedIn: this.currentDirectory,
      };
    }

    this.currentDirectory = validatedPath;
    return {
      success: true,
      stdout: `Changed directory to: ${this.currentDirectory}`,
      stderr: "",
      exitCode: 0,
      executedIn: this.currentDirectory,
    };
  }

  private async runCommand(command: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      const useShell = command.includes(">") || command.includes("<") || command.includes("|");

      let cmd: string;
      let args: string[];

      if (useShell) {
        cmd = "sh";
        args = ["-c", command];
        logger.info(`Executing shell command: sh -c "${command}" in ${this.currentDirectory}`);
      } else {
        const parts = command.split(/\s+/);
        cmd = parts[0];
        args = parts.slice(1);
        logger.info(`Executing command: ${cmd} ${args.join(" ")} in ${this.currentDirectory}`);
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const child = spawn(cmd, args, {
        cwd: this.currentDirectory,
        env: process.env,
        shell: false,
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 5000);
      }, this.shellConfig.timeout);

      if (child.stdout) {
        child.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
      }

      child.on("exit", (code) => {
        clearTimeout(timeout);

        if (timedOut) {
          resolve({
            success: false,
            stdout,
            stderr: `${stderr}\nCommand timed out`,
            exitCode: code,
            error: "Command execution timeout",
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

      child.on("error", (err: Error) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          stdout,
          stderr: err.message,
          exitCode: 1,
          error: "Failed to execute command",
          executedIn: this.currentDirectory,
        });
      });
    });
  }

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
      fileOperations,
    };

    if (!this.commandHistory.has(conversationId)) {
      this.commandHistory.set(conversationId, []);
    }

    const history = this.commandHistory.get(conversationId);
    if (!history) {
      throw new Error(`No history found for conversation ${conversationId}`);
    }
    history.push(historyEntry);

    if (history.length > this.maxHistoryPerConversation) {
      history.shift();
    }
  }

  private detectFileOperations(command: string, cwd: string): FileOperation[] | undefined {
    const operations: FileOperation[] = [];
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === "touch" && parts.length > 1) {
      operations.push({
        type: "create" as FileOperationType,
        target: this.resolvePath(parts[1], cwd),
      });
    } else if (cmd === "echo" && command.includes(">")) {
      const match = command.match(/>\s*([^\s]+)$/);
      if (match) {
        operations.push({
          type: "write" as FileOperationType,
          target: this.resolvePath(match[1], cwd),
        });
      }
    } else if (cmd === "mkdir" && parts.length > 1) {
      operations.push({
        type: "mkdir" as FileOperationType,
        target: this.resolvePath(parts[1], cwd),
      });
    } else if (cmd === "cat" && parts.length > 1 && !command.includes(">")) {
      operations.push({
        type: "read" as FileOperationType,
        target: this.resolvePath(parts[1], cwd),
      });
    } else if (cmd === "mv" && parts.length > 2) {
      operations.push({
        type: "move" as FileOperationType,
        target: this.resolvePath(parts[1], cwd),
        secondaryTarget: this.resolvePath(parts[2], cwd),
      });
    } else if (cmd === "cp" && parts.length > 2) {
      operations.push({
        type: "copy" as FileOperationType,
        target: this.resolvePath(parts[1], cwd),
        secondaryTarget: this.resolvePath(parts[2], cwd),
      });
    }

    return operations.length > 0 ? operations : undefined;
  }

  private resolvePath(filePath: string, cwd: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.join(cwd, filePath);
  }

  getCommandHistory(conversationId: string, limit?: number): CommandHistoryEntry[] {
    const history = this.commandHistory.get(conversationId) || [];
    if (limit && limit > 0) {
      return history.slice(-limit);
    }
    return history;
  }

  clearCommandHistory(conversationId: string): void {
    this.commandHistory.delete(conversationId);
    logger.info(`Cleared command history for conversation: ${conversationId}`);
  }

  getCurrentDirectory(_conversationId?: string): string {
    return this.currentDirectory;
  }

  getAllowedDirectory(): string {
    return this.shellConfig.allowedDirectory;
  }
}
