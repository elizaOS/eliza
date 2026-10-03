/** Browser console sink using core's canonical credential redaction and logger contract. */
import type { Logger, LoggerBindings } from "@elizaos/core";
import { redactTrailingArgs } from "@elizaos/core/security/log-redaction";

const ranks: Record<string, number> = {
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

export function createLogger(
  bindings: LoggerBindings | boolean = false,
): Logger {
  const context = typeof bindings === "boolean" ? {} : bindings;
  const write = (level: string, values: unknown[]) => {
    if (ranks[level] < (ranks[result.level] ?? ranks.info)) return;
    const method =
      level === "fatal"
        ? "error"
        : level === "trace"
          ? "debug"
          : level === "success" || level === "progress"
            ? "info"
            : level;
    const sink =
      method === "error"
        ? console.error
        : method === "warn"
          ? console.warn
          : method === "debug"
            ? console.debug
            : console.info;
    sink(...redactTrailingArgs([context, ...values]));
  };
  const result: Logger = {
    level: context.level ?? "info",
    trace: (...args) => write("trace", args),
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    log: (...args) => write("log", args),
    success: (...args) => write("success", args),
    progress: (...args) => write("progress", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    fatal: (...args) => write("fatal", args),
    clear: () => console.clear(),
    child: (childBindings) =>
      createLogger({ ...context, level: result.level, ...childBindings }),
  };
  return result;
}

export const logger = createLogger();
export type { Logger, LoggerBindings };
export { logger as elizaLogger, logger as default };
