/**
 * Simple logger for the Discord gateway service.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info") as LogLevel;
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL];
}

function formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const base = { timestamp, level, message, ...meta };
  return JSON.stringify(base);
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>) {
    if (shouldLog("debug")) console.log(formatMessage("debug", message, meta));
  },
  info(message: string, meta?: Record<string, unknown>) {
    if (shouldLog("info")) console.log(formatMessage("info", message, meta));
  },
  warn(message: string, meta?: Record<string, unknown>) {
    if (shouldLog("warn")) console.warn(formatMessage("warn", message, meta));
  },
  error(message: string, meta?: Record<string, unknown>) {
    if (shouldLog("error")) console.error(formatMessage("error", message, meta));
  },
};
