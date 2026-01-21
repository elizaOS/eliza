/**
 * Shared Logger Utility
 *
 * @description Production-ready logging with configurable levels and environment
 * awareness. Provides structured logging with context, data serialization, and
 * automatic level filtering based on environment.
 */

import type { JsonValue } from "../types/common";

/**
 * Log data payload - structured data for logging
 * Accepts JsonValue, Error, or any object that can be serialized
 */
// biome-ignore lint/suspicious/noExplicitAny: LogData must accept arbitrary objects for logging
export type LogData = Record<string, any> | Error | JsonValue;

/**
 * Log level type
 *
 * @description Valid log levels ordered by severity: debug < info < warn < error
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Log entry structure
 *
 * @description Internal structure for log entries before formatting.
 */
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: LogData;
  context?: string;
}

/**
 * Logger Class
 *
 * @description Provides structured logging with configurable levels, context
 * support, and safe serialization of complex objects. Handles cyclic references
 * and Error objects gracefully.
 */
export class Logger {
  private level: LogLevel;
  private levelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(level?: LogLevel) {
    // Allow explicit level override (for A2A compatibility)
    if (level && this.levelPriority[level] !== undefined) {
      this.level = level;
    } else {
      // Set log level based on environment
      const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
      if (envLevel && this.levelPriority[envLevel] !== undefined) {
        this.level = envLevel;
      } else {
        // Default: debug in development, info in production
        this.level = process.env.NODE_ENV === "production" ? "info" : "debug";
      }
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levelPriority[level] >= this.levelPriority[this.level];
  }

  private formatLog(entry: LogEntry): string {
    const contextStr = entry.context ? `[${entry.context}]` : "";
    let dataStr = "";
    if (entry.data) {
      // Handle cyclic structures and errors safely
      // Create a replacer function with persistent seen set
      const seen = new Set<JsonValue>();
      const replacer = (_key: string, value: JsonValue): JsonValue => {
        // Handle Error objects specially
        if (value instanceof Error) {
          return {
            name: value.name,
            message: value.message,
            stack: value.stack ?? null,
          } satisfies Record<string, JsonValue>;
        }
        // Handle cyclic references
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) {
            return "[Circular]";
          }
          seen.add(value);
        }
        return value;
      };
      dataStr = ` ${JSON.stringify(entry.data, replacer)}`;
    }
    return `[${entry.timestamp}] ${contextStr} [${entry.level.toUpperCase()}] ${entry.message}${dataStr}`;
  }

  private log(
    level: LogLevel,
    message: string,
    data?: LogData,
    context?: string,
  ): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
      context,
    };

    const formatted = this.formatLog(entry);

    // In production, we might want to send errors to external logging service
    // For now, use console methods but through a structured logger
    switch (level) {
      case "debug":
      case "info":
        console.log(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      case "error":
        console.error(formatted);
        break;
    }
  }

  /**
   * Log a debug message
   *
   * @description Logs a debug-level message. Only shown if log level is set to debug.
   *
   * @param {string} message - Log message
   * @param {LogData} [data] - Optional data object
   * @param {string} [context] - Optional context identifier
   */
  debug(message: string, data?: LogData, context?: string): void {
    this.log("debug", message, data, context);
  }

  /**
   * Log an info message
   *
   * @description Logs an info-level message. Shown for info, warn, and error levels.
   *
   * @param {string} message - Log message
   * @param {LogData} [data] - Optional data object
   * @param {string} [context] - Optional context identifier
   */
  info(message: string, data?: LogData, context?: string): void {
    this.log("info", message, data, context);
  }

  /**
   * Log a warning message
   *
   * @description Logs a warning-level message. Shown for warn and error levels.
   *
   * @param {string} message - Log message
   * @param {LogData} [data] - Optional data object
   * @param {string} [context] - Optional context identifier
   */
  warn(message: string, data?: LogData, context?: string): void {
    this.log("warn", message, data, context);
  }

  /**
   * Log an error message
   *
   * @description Logs an error-level message. Always shown regardless of log level.
   *
   * @param {string} message - Log message
   * @param {LogData} [data] - Optional data object (often an Error)
   * @param {string} [context] - Optional context identifier
   */
  error(message: string, data?: LogData, context?: string): void {
    this.log("error", message, data, context);
  }

  /**
   * Set the log level
   *
   * @description Changes the minimum log level. Messages below this level
   * will be filtered out.
   *
   * @param {LogLevel} level - New log level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Get the current log level
   *
   * @description Returns the current minimum log level.
   *
   * @returns {LogLevel} Current log level
   */
  getLevel(): LogLevel {
    return this.level;
  }
}

/**
 * Singleton logger instance
 *
 * @description Default logger instance used throughout the application.
 * Configured based on LOG_LEVEL environment variable or defaults to 'debug'
 * in development and 'info' in production.
 */
export const logger = new Logger();
