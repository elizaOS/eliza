/**
 * Database Logger
 *
 * Simple logger interface for database operations that can be overridden by consumers.
 * Falls back to console logging by default.
 */

/**
 * Logger interface for database operations.
 */
export interface Logger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Default console logger implementation.
 */
const defaultLogger: Logger = {
  debug: (message: string, meta?: Record<string, unknown>) => {
    if (process.env.NODE_ENV === "development" || process.env.DEBUG) {
      console.debug(message, meta ?? "");
    }
  },
  info: (message: string, meta?: Record<string, unknown>) => {
    console.info(message, meta ?? "");
  },
  warn: (message: string, meta?: Record<string, unknown>) => {
    console.warn(message, meta ?? "");
  },
  error: (message: string, meta?: Record<string, unknown>) => {
    console.error(message, meta ?? "");
  },
};

let currentLogger: Logger = defaultLogger;

/**
 * Get the current logger instance.
 *
 * @returns Current logger implementation
 */
export function getLogger(): Logger {
  return currentLogger;
}

/**
 * Set a custom logger implementation
 */
export function setLogger(customLogger: Logger): void {
  currentLogger = customLogger;
}

/**
 * Logger instance for use within the db package
 */
export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) =>
    currentLogger.debug(message, meta),
  info: (message: string, meta?: Record<string, unknown>) =>
    currentLogger.info(message, meta),
  warn: (message: string, meta?: Record<string, unknown>) =>
    currentLogger.warn(message, meta),
  error: (message: string, meta?: Record<string, unknown>) =>
    currentLogger.error(message, meta),
};
