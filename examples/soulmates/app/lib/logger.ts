import { randomUUID } from "node:crypto";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogEntry = {
  level: LogLevel;
  message: string;
  requestId?: string;
  context?: Record<string, unknown>;
  timestamp: string;
  service: string;
};

const SERVICE = "soulmates";

function formatEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}

function log(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
  requestId?: string,
): void {
  const entry: LogEntry = {
    level,
    message,
    requestId,
    context,
    timestamp: new Date().toISOString(),
    service: SERVICE,
  };

  const output = formatEntry(entry);

  switch (level) {
    case "error":
      console.error(output);
      break;
    case "warn":
      console.warn(output);
      break;
    default:
      console.log(output);
  }
}

export const logger = {
  debug: (
    message: string,
    context?: Record<string, unknown>,
    requestId?: string,
  ) => log("debug", message, context, requestId),
  info: (
    message: string,
    context?: Record<string, unknown>,
    requestId?: string,
  ) => log("info", message, context, requestId),
  warn: (
    message: string,
    context?: Record<string, unknown>,
    requestId?: string,
  ) => log("warn", message, context, requestId),
  error: (
    message: string,
    context?: Record<string, unknown>,
    requestId?: string,
  ) => log("error", message, context, requestId),
};

export function generateRequestId(): string {
  return randomUUID().slice(0, 8);
}
