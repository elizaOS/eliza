/**
 * Structured client logger for the phone-companion views.
 *
 * Client-side code cannot reach the server logger — this wrapper provides
 * levelled, prefixed output routed through the browser console host.
 * Prefix each call site with `[ClassName]` per repo convention.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function envLevel(): LogLevel {
  const raw =
    typeof import.meta !== "undefined"
      ? (import.meta as { env?: Record<string, string> }).env
          ?.VITE_ELIZA_LOG_LEVEL
      : undefined;
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

const currentLevel = envLevel();

function emit(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const line = `[ElizaCompanion] ${message}`;
  const host = globalThis.console;
  if (level === "error") {
    host.error(line, context ?? {});
    return;
  }
  if (level === "warn") {
    host.warn(line, context ?? {});
    return;
  }
  if (level === "info") {
    host.info(line, context ?? {});
    return;
  }
  host.debug(line, context ?? {});
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    emit("debug", message, context);
  },
  info(message: string, context?: Record<string, unknown>): void {
    emit("info", message, context);
  },
  warn(message: string, context?: Record<string, unknown>): void {
    emit("warn", message, context);
  },
  error(message: string, context?: Record<string, unknown>): void {
    emit("error", message, context);
  },
};
