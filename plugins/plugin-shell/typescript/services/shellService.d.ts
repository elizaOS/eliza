/**
 * Enhanced Shell Service with PTY, background execution, and session management
 * Migrated from otto bash-tools.exec.ts, bash-tools.process.ts
 */
import { type IAgentRuntime, Service } from "@elizaos/core";
import type {
  CommandHistoryEntry,
  CommandResult,
  ExecResult,
  ExecuteOptions,
  FinishedSession,
  ProcessActionParams,
  ProcessSession,
  ShellConfig,
} from "../types";
export declare class ShellService extends Service {
  static serviceType: string;
  private shellConfig;
  private currentDirectory;
  private commandHistory;
  private maxHistoryPerConversation;
  private scopeKey?;
  constructor(runtime: IAgentRuntime);
  static start(runtime: IAgentRuntime): Promise<ShellService>;
  stop(): Promise<void>;
  get capabilityDescription(): string;
  /**
   * Set scope key for session isolation
   */
  setScopeKey(scopeKey: string): void;
  /**
   * Simple command execution (original API for backward compatibility)
   */
  executeCommand(command: string, conversationId?: string): Promise<CommandResult>;
  /**
   * Enhanced command execution with PTY, background support, and session management
   * This is the main execution method that supports all advanced features
   */
  exec(command: string, options?: ExecuteOptions): Promise<ExecResult>;
  /**
   * Process management action handler
   * Supports: list, poll, log, write, send-keys, submit, paste, kill, clear, remove
   */
  processAction(params: ProcessActionParams): Promise<{
    success: boolean;
    message: string;
    data?: Record<string, unknown>;
  }>;
  /**
   * List all running sessions
   */
  listRunningSessions(): ProcessSession[];
  /**
   * List all finished sessions
   */
  listFinishedSessions(): FinishedSession[];
  /**
   * Get a specific session by ID
   */
  getSession(id: string): ProcessSession | undefined;
  /**
   * Get a specific finished session by ID
   */
  getFinishedSession(id: string): FinishedSession | undefined;
  /**
   * Kill a session by ID
   */
  killSessionById(id: string): boolean;
  /**
   * Get command history for a conversation
   */
  getCommandHistory(conversationId: string, limit?: number): CommandHistoryEntry[];
  /**
   * Clear command history for a conversation
   */
  clearCommandHistory(conversationId: string): void;
  /**
   * Get current working directory
   */
  getCurrentDirectory(_conversationId?: string): string;
  /**
   * Set current working directory
   */
  setCurrentDirectory(directory: string): boolean;
  /**
   * Get allowed directory
   */
  getAllowedDirectory(): string;
  /**
   * Get shell configuration
   */
  getShellConfig(): ShellConfig;
  private handleCdCommand;
  private runCommandSimple;
  private runExecProcess;
  private addToHistory;
  private detectFileOperations;
  private resolvePath;
}
