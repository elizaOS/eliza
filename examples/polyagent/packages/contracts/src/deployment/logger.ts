/**
 * Simple Logger for Deployment Utilities
 *
 * Minimal logger to avoid circular dependency with @polyagent/shared
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) ||
  (process.env.NODE_ENV === "production" ? "info" : "debug");

function shouldLog(level: LogLevel): boolean {
  return levelPriority[level] >= levelPriority[currentLevel];
}

function formatLog(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
  context?: string,
): string {
  const timestamp = new Date().toISOString();
  const contextStr = context ? `[${context}]` : "";
  const dataStr = data ? ` ${JSON.stringify(data)}` : "";
  return `[${timestamp}] ${contextStr} [${level.toUpperCase()}] ${message}${dataStr}`;
}

export const logger = {
  debug(
    message: string,
    data?: Record<string, unknown>,
    context?: string,
  ): void {
    if (shouldLog("debug")) {
      console.log(formatLog("debug", message, data, context));
    }
  },

  info(
    message: string,
    data?: Record<string, unknown>,
    context?: string,
  ): void {
    if (shouldLog("info")) {
      console.log(formatLog("info", message, data, context));
    }
  },

  warn(
    message: string,
    data?: Record<string, unknown>,
    context?: string,
  ): void {
    if (shouldLog("warn")) {
      console.warn(formatLog("warn", message, data, context));
    }
  },

  error(
    message: string,
    data?: Record<string, unknown>,
    context?: string,
  ): void {
    if (shouldLog("error")) {
      console.error(formatLog("error", message, data, context));
    }
  },
};
