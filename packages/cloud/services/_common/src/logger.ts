/**
 * Structured JSON logger factory shared by cloud-services packages.
 *
 * Output is one JSON object per line, controlled by the LOG_LEVEL env var
 * (debug | info | warn | error, default "info"). LOG_LEVEL is re-read on
 * every call so tests can change it dynamically.
 *
 * Field order matches the existing per-service loggers:
 *   - gateway-style (default): { timestamp, level, message, ...meta }
 *   - meta-first style (agent-server): { ...meta, timestamp, level, message }
 *
 * Production log parsers depend on this format — do not change it.
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

export interface ServiceLoggerOptions {
  /**
   * When true, structured metadata is spread before the standard fields
   * (matches the agent-server format: `{ ...meta, timestamp, level, message }`).
   * Defaults to false: `{ timestamp, level, message, ...meta }`.
   */
  metaFirst?: boolean;
}

export interface ServiceLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  shouldLog(level: LogLevel): boolean;
}

export function createServiceLogger(
  _serviceName: string,
  options: ServiceLoggerOptions = {},
): ServiceLogger {
  const metaFirst = options.metaFirst ?? false;

  function formatMessage(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): string {
    const timestamp = new Date().toISOString();
    const base = metaFirst
      ? { ...meta, timestamp, level, message }
      : { timestamp, level, message, ...meta };
    return JSON.stringify(base);
  }

  return {
    debug(message, meta) {
      if (shouldLog("debug")) {
        console.log(formatMessage("debug", message, meta));
      }
    },
    info(message, meta) {
      if (shouldLog("info")) {
        console.log(formatMessage("info", message, meta));
      }
    },
    warn(message, meta) {
      if (shouldLog("warn")) {
        console.warn(formatMessage("warn", message, meta));
      }
    },
    error(message, meta) {
      if (shouldLog("error")) {
        console.error(formatMessage("error", message, meta));
      }
    },
    shouldLog,
  };
}
