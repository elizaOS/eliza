/**
 * Stub for @walletconnect/logger that provides console-based logging.
 * This is needed because @walletconnect/logger uses pino which creates
 * dynamic worker modules (like pino-28069d5257187539) that cannot be
 * resolved in serverless / Workers environments.
 *
 * This stub provides a simple console-based logger implementation.
 */

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

interface Logger {
  context?: string;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  child: (bindings?: Record<string, unknown>) => Logger;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function createLogger(level: LogLevel = "info", bindings?: Record<string, unknown>): Logger {
  const minLevel = LOG_LEVELS[level] || LOG_LEVELS.info;
  const context = typeof bindings?.context === "string" ? bindings.context : undefined;

  const log =
    (logLevel: LogLevel, method: "log" | "warn" | "error") =>
    (...args: unknown[]) => {
      if (LOG_LEVELS[logLevel] >= minLevel) {
        console[method](`[${logLevel.toUpperCase()}]`, ...args);
      }
    };

  return {
    context,
    trace: log("trace", "log"),
    debug: log("debug", "log"),
    info: log("info", "log"),
    warn: log("warn", "warn"),
    error: log("error", "error"),
    fatal: log("fatal", "error"),
    child: (bindings?: Record<string, unknown>) => createLogger(level, bindings),
  };
}

/**
 * Generate a logger with optional context namespace
 */
export function generateChildLogger(logger: Logger, context: string): Logger {
  return logger.child({ context });
}

/**
 * Generate a platform logger (used by @walletconnect/utils)
 */
export function generatePlatformLogger(level: LogLevel = "info"): {
  logger: Logger;
  chunkLoggerController: null;
} {
  return {
    logger: createLogger(level),
    chunkLoggerController: null,
  };
}

/**
 * Get the logger context (namespace)
 */
export function getLoggerContext(logger: Logger): string {
  return logger.context || "";
}

/**
 * Set the logger level
 */
export function setLoggerLevel(logger: Logger, level: LogLevel): void {
  // No-op for stub - level is set at creation time
  void logger;
  void level;
}

/**
 * Get the default log level
 */
export function getDefaultLoggerOptions(): { level: LogLevel } {
  return { level: "info" };
}

/**
 * Create a pino-compatible logger
 */
export function pino(opts?: { level?: LogLevel } | LogLevel): Logger {
  const level = typeof opts === "string" ? opts : (opts?.level ?? "info");
  return createLogger(level);
}

// Named exports matching @walletconnect/logger API
export const formatChildLoggerContext = (context: string): string => context;

const walletconnectLogger = {
  pino,
  generateChildLogger,
  generatePlatformLogger,
  getLoggerContext,
  setLoggerLevel,
  getDefaultLoggerOptions,
  formatChildLoggerContext,
};

// Default export
export default walletconnectLogger;
