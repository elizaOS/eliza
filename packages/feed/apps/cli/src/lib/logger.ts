/**
 * @fileoverview CLI logging utilities
 *
 * Provides structured logging functions for CLI output with consistent formatting.
 *
 * @module cli/lib/logger
 */

/**
 * Supported log data types.
 */
type LogData = string | string[] | Record<string, unknown> | Error;

/**
 * CLI logger with structured output methods.
 *
 * Provides consistent logging with prefixes, emoji indicators, and formatted output.
 * Debug logs are only shown when `DEBUG` environment variable is set.
 */
export const logger = {
  /**
   * Logs an informational message.
   *
   * @param msg - Message to log
   * @param data - Optional additional data to include
   */
  info: (msg: string, data?: LogData): void => {
    if (data) {
      console.log(`[INFO] ${msg}`, data);
    } else {
      console.log(`[INFO] ${msg}`);
    }
  },

  /**
   * Logs an error message.
   *
   * @param msg - Error message to log
   * @param data - Optional additional error data
   */
  error: (msg: string, data?: LogData): void => {
    if (data) {
      console.error(`[ERROR] ${msg}`, data);
    } else {
      console.error(`[ERROR] ${msg}`);
    }
  },

  /**
   * Logs a warning message.
   *
   * @param msg - Warning message to log
   * @param data - Optional additional warning data
   */
  warn: (msg: string, data?: LogData): void => {
    if (data) {
      console.warn(`[WARN] ${msg}`, data);
    } else {
      console.warn(`[WARN] ${msg}`);
    }
  },

  /**
   * Logs a debug message (only when DEBUG environment variable is set).
   *
   * @param msg - Debug message to log
   * @param data - Optional additional debug data
   */
  debug: (msg: string, data?: LogData): void => {
    if (process.env.DEBUG) {
      if (data) {
        console.log(`[DEBUG] ${msg}`, data);
      } else {
        console.log(`[DEBUG] ${msg}`);
      }
    }
  },

  /**
   * Logs a success message with checkmark indicator.
   *
   * @param msg - Success message to log
   */
  success: (msg: string): void => {
    console.log(`✅ ${msg}`);
  },

  /**
   * Logs a failure message with cross indicator.
   *
   * @param msg - Failure message to log
   */
  fail: (msg: string): void => {
    console.log(`❌ ${msg}`);
  },

  /**
   * Logs a step indicator message.
   *
   * @param msg - Step message to log
   */
  step: (msg: string): void => {
    console.log(`→ ${msg}`);
  },

  /**
   * Logs a formatted header with title.
   *
   * @param title - Header title to display
   */
  header: (title: string): void => {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  ${title}`);
    console.log(`${"═".repeat(60)}\n`);
  },
};
