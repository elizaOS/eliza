import { type IAgentRuntime } from '@elizaos/core';
import { type LogEntry, LogLevel, OODAPhase } from './types';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createWriteStream, type WriteStream } from 'fs';

export interface LoggerConfig {
  level: LogLevel;
  enableFileLogging: boolean;
  logDirectory: string;
  maxFileSize: number;
  maxFiles: number;
  enableConsole: boolean;
  enableStructured: boolean;
}

export class AutonomyLogger {
  private config: LoggerConfig;
  private runtime: IAgentRuntime;
  private currentRunId: string | null = null;
  private fileStream: WriteStream | null = null;
  private logBuffer: LogEntry[] = [];
  private recentLogs: LogEntry[] = []; // Keep recent logs for querying
  private flushInterval: NodeJS.Timeout | null = null;
  private static instance: AutonomyLogger | null = null;

  constructor(runtime: IAgentRuntime, config?: Partial<LoggerConfig>) {
    this.runtime = runtime;
    this.config = {
      level: LogLevel.INFO,
      enableFileLogging: process.env.AUTONOMOUS_FILE_LOGGING === 'true',
      logDirectory: process.env.AUTONOMOUS_LOG_DIR || './logs/autonomy',
      maxFileSize: 50 * 1024 * 1024, // 50MB
      maxFiles: 100,
      enableConsole: true,
      enableStructured: true,
      ...config,
    };

    if (this.config.enableFileLogging) {
      this.setupFileLogging();
    }

    // Flush logs every second
    this.flushInterval = setInterval(() => this.flush(), 1000);
  }

  private async setupFileLogging() {
    try {
      await fs.mkdir(this.config.logDirectory, { recursive: true });
    } catch (error) {
      console.error('Failed to create log directory:', error);
    }
  }

  async startRun(runId: string): Promise<void> {
    this.currentRunId = runId;

    if (this.config.enableFileLogging) {
      // Close previous stream if exists
      if (this.fileStream) {
        this.fileStream.end();
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `run_${runId}_${timestamp}.log`;
      const filepath = path.join(this.config.logDirectory, filename);

      this.fileStream = createWriteStream(filepath, { flags: 'a' });

      // Write run header
      const header = {
        runId,
        startTime: new Date().toISOString(),
        agentId: this.runtime.agentId,
        agentName: this.runtime.character.name,
        config: this.config,
      };

      this.fileStream.write(`=== AUTONOMY RUN START ===\n`);
      this.fileStream.write(JSON.stringify(header, null, 2) + '\n');
      this.fileStream.write(`========================\n\n`);
    }

    this.info('Starting new autonomy run', { runId });
  }

  async endRun(): Promise<void> {
    if (this.currentRunId) {
      this.info('Ending autonomy run', { runId: this.currentRunId });

      if (this.fileStream) {
        this.fileStream.write(`\n=== AUTONOMY RUN END ===\n`);
        this.fileStream.write(`Run ID: ${this.currentRunId}\n`);
        this.fileStream.write(`End Time: ${new Date().toISOString()}\n`);
        this.fileStream.write(`======================\n`);
        this.fileStream.end();
        this.fileStream = null;
      }

      this.currentRunId = null;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR, LogLevel.FATAL];
    const configIndex = levels.indexOf(this.config.level);
    const messageIndex = levels.indexOf(level);
    return messageIndex >= configIndex;
  }

  private formatMessage(entry: LogEntry): string {
    if (this.config.enableStructured) {
      return JSON.stringify({
        ...entry,
        agentId: this.runtime.agentId,
        agentName: this.runtime.character.name,
      });
    }

    const timestamp = new Date(entry.timestamp).toISOString();
    const phase = entry.phase ? `[${entry.phase}]` : '';
    const level = `[${entry.level.toUpperCase()}]`;
    const runId = entry.runId ? `[${entry.runId.substring(0, 8)}]` : '';

    let message = `${timestamp} ${level} ${runId} ${phase} ${entry.message}`;

    if (entry.data) {
      message += ` | Data: ${JSON.stringify(entry.data)}`;
    }

    if (entry.error) {
      message += ` | Error: ${entry.error.message} | Stack: ${entry.error.stack}`;
    }

    return message;
  }

  private async log(
    level: LogLevel,
    message: string,
    data?: any,
    error?: Error,
    phase?: OODAPhase
  ): Promise<void> {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      runId: this.currentRunId || 'no-run',
      timestamp: Date.now(),
      level,
      phase: phase || OODAPhase.IDLE,
      message,
      data,
      error,
    };

    this.logBuffer.push(entry);

    // Immediate flush for errors and fatal
    if (level === LogLevel.ERROR || level === LogLevel.FATAL) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.logBuffer.length === 0) {
      return;
    }

    const entries = [...this.logBuffer];
    this.logBuffer = [];

    // Add to recent logs (keep last 1000)
    this.recentLogs.push(...entries);
    if (this.recentLogs.length > 1000) {
      this.recentLogs = this.recentLogs.slice(-1000);
    }

    for (const entry of entries) {
      const formatted = this.formatMessage(entry);

      // Console logging
      if (this.config.enableConsole) {
        switch (entry.level) {
          case LogLevel.DEBUG:
            console.debug(formatted);
            break;
          case LogLevel.INFO:
            console.log(formatted);
            break;
          case LogLevel.WARN:
            console.warn(formatted);
            break;
          case LogLevel.ERROR:
          case LogLevel.FATAL:
            console.error(formatted);
            break;
        }
      }

      // File logging
      if (this.config.enableFileLogging && this.fileStream && !this.fileStream.destroyed) {
        this.fileStream.write(formatted + '\n');
      }
    }
  }

  // Public logging methods
  debug(message: string, data?: any, phase?: OODAPhase): void {
    this.log(LogLevel.DEBUG, message, data, undefined, phase);
  }

  info(message: string, data?: any, phase?: OODAPhase): void {
    this.log(LogLevel.INFO, message, data, undefined, phase);
  }

  warn(message: string, data?: any, phase?: OODAPhase): void {
    this.log(LogLevel.WARN, message, data, undefined, phase);
  }

  error(message: string, error?: Error, data?: any, phase?: OODAPhase): void {
    this.log(LogLevel.ERROR, message, data, error, phase);
  }

  fatal(message: string, error?: Error, data?: any, phase?: OODAPhase): void {
    this.log(LogLevel.FATAL, message, data, error, phase);
  }

  // Phase-specific logging helpers
  observing(message: string, data?: any): void {
    this.info(message, data, OODAPhase.OBSERVING);
  }

  orienting(message: string, data?: any): void {
    this.info(message, data, OODAPhase.ORIENTING);
  }

  deciding(message: string, data?: any): void {
    this.info(message, data, OODAPhase.DECIDING);
  }

  acting(message: string, data?: any): void {
    this.info(message, data, OODAPhase.ACTING);
  }

  reflecting(message: string, data?: any): void {
    this.info(message, data, OODAPhase.REFLECTING);
  }

  // Metrics logging
  logMetrics(metrics: any): void {
    this.info('Loop metrics', metrics);
  }

  // Action logging
  logAction(action: string, result: any, duration: number): void {
    this.info(`Action completed: ${action}`, {
      action,
      result,
      durationMs: duration,
    });
  }

  // Error logging with context
  logError(error: Error, context: any): void {
    this.error(`Error in ${context.phase || 'unknown'} phase`, error, context);
  }

  // Query logs
  async queryLogs(params: {
    runId?: string;
    phase?: OODAPhase;
    level?: LogLevel;
    limit?: number;
  }): Promise<LogEntry[]> {
    // For now, return from recent logs
    // In production, this would query from persistent storage
    let results = [...this.recentLogs, ...this.logBuffer];

    if (params.runId) {
      results = results.filter((log) => log.runId === params.runId);
    }

    if (params.phase) {
      results = results.filter((log) => log.phase === params.phase);
    }

    if (params.level) {
      results = results.filter((log) => log.level === params.level);
    }

    if (params.limit) {
      results = results.slice(-params.limit);
    }

    return results;
  }

  // Cleanup
  async destroy(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }

    await this.flush();

    if (this.fileStream) {
      this.fileStream.end();
    }
  }

  // Method to reset singleton (for testing)
  static reset() {
    AutonomyLogger.instance = null;
  }
}

// Singleton logger instance
let loggerInstance: AutonomyLogger | null = null;

export function getLogger(runtime: IAgentRuntime): AutonomyLogger {
  if (!loggerInstance) {
    loggerInstance = new AutonomyLogger(runtime);
  }
  return loggerInstance;
}

export function resetLogger(): void {
  if (loggerInstance) {
    loggerInstance.destroy();
    loggerInstance = null;
  }
}
