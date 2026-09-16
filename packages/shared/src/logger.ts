/** Browser/client logging. Runtime file sinks and log streaming belong to core. */

import { redactTrailingArgs } from "@elizaos/common";
import type { Logger, LoggerBindings } from "@elizaos/core";

export type { Logger, LoggerBindings } from "@elizaos/core";

const levels: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  log: 30,
  success: 30,
  progress: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
};

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[Unserializable log value]";
  }
}

export function createLogger(
  bindings: LoggerBindings | boolean = false,
): Logger {
  const safeBindings =
    typeof bindings === "object"
      ? (redactTrailingArgs([bindings])[0] as Record<string, unknown>)
      : {};
  const env = (globalThis as { window?: { ENV?: Record<string, unknown> } })
    .window?.ENV;
  const configuredLevel =
    typeof safeBindings?.level === "string"
      ? safeBindings.level
      : env?.LOG_LEVEL;
  const level =
    typeof configuredLevel === "string"
      ? configuredLevel.toLowerCase()
      : "info";
  const emit = (method: string, ...args: unknown[]): void => {
    if ((levels[method] ?? 30) < (levels[result.level] ?? 30)) return;
    const safe = redactTrailingArgs(args);
    const prefix =
      typeof safeBindings?.namespace === "string"
        ? `[${safeBindings.namespace}] `
        : "";
    const sink =
      method === "fatal"
        ? "error"
        : method === "trace"
          ? "debug"
          : method === "success" || method === "progress"
            ? "info"
            : method;
    try {
      const fn = console[sink as "debug" | "info" | "warn" | "error" | "log"];
      fn.call(console, prefix + safe.map(render).join(" "));
    } catch {
      /* A failed diagnostic sink must not interrupt the client. */
    }
  };
  const result: Logger = {
    level,
    trace: (...args) => emit("trace", ...args),
    debug: (...args) => emit("debug", ...args),
    info: (...args) => emit("info", ...args),
    warn: (...args) => emit("warn", ...args),
    error: (...args) => emit("error", ...args),
    fatal: (...args) => emit("fatal", ...args),
    success: (...args) => emit("success", ...args),
    progress: (...args) => emit("progress", ...args),
    log: (...args) => emit("log", ...args),
    clear: () => console.clear(),
    child: (childBindings) =>
      createLogger({
        ...safeBindings,
        level: result.level,
        ...(redactTrailingArgs([childBindings])[0] as Record<string, unknown>),
      }),
  };
  return result;
}
export const logger = createLogger();
export const elizaLogger = logger;
export default logger;
