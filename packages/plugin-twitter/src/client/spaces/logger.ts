// src/logger.ts

/**
 * Represents a Logger class for logging information, debug messages, warnings, and errors.
 */
export class Logger {
  private readonly debugEnabled: boolean;

  /**
   * Constructor for initializing a new instance of the class.
   *
   * @param {boolean} debugEnabled - Specifies whether debug mode is enabled or not.
   */
  constructor(debugEnabled: boolean) {
    this.debugEnabled = debugEnabled;
  }

  /**
   * Logs an info message with optional additional arguments.
   *
   * @param {string} msg - The info message to log.
   * @param {...any} args - Additional arguments to include in the log message.
   */
  info(msg: string, ...args: any[]) {
    console.log(msg, ...args);
  }

  /**
   * Logs a debug message if debug mode is enabled.
   *
   * @param {string} msg - The debug message to be logged.
   * @param {...any} args - Additional arguments to be passed to the console.log function.
   */
  debug(msg: string, ...args: any[]) {
    if (this.debugEnabled) {
      console.log(msg, ...args);
    }
  }

  /**
   * Logs a warning message to the console.
   *
   * @param {string} msg The warning message to be logged.
   * @param {...any} args Additional arguments to be logged along with the message.
   */
  warn(msg: string, ...args: any[]) {
    console.warn('[WARN]', msg, ...args);
  }

  /**
   * Logs an error message to the console.
   *
   * @param {string} msg - The error message to be logged.
   * @param {...any} args - Additional arguments to be logged along with the error message.
   */
  error(msg: string, ...args: any[]) {
    console.error(msg, ...args);
  }

  /**
   * Check if debug mode is enabled.
   * @returns {boolean} True if debug mode is enabled, false otherwise.
   */
  isDebugEnabled(): boolean {
    return this.debugEnabled;
  }
}
