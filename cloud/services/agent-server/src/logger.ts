/**
 * Structured JSON logger for the agent-server service.
 *
 * Mirrors the gateway-webhook logger pattern: level-gated, JSON-formatted
 * output with ISO-8601 timestamps and optional structured metadata.
 * Controlled via the LOG_LEVEL env var (default: "info").
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const LOG_LEVEL_VALUES = ["debug", "info", "warn", "error"] as const;

function getCurrentLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL;
  return LOG_LEVEL_VALUES.find((level) => level === envLevel) ?? "info";
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[getCurrentLogLevel()];
}

function formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const base = { ...meta, timestamp, level, message };
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
