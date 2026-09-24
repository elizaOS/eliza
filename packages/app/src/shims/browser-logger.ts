/** Sends renderer diagnostics to the browser console with canonical secret redaction.
 * Runtime file sinks and memory-log transport remain owned by the Node logger. */
import type { Logger, LoggerBindings } from "../../../core/src/logger.ts";
import {
  REDACTION_FAILED_VALUE,
  redactTrailingArgs,
} from "../../../core/src/security/log-redaction.ts";

export type { Logger, LoggerBindings };

const priorities: Record<string, number> = {
  trace: 10,
  verbose: 10,
  debug: 20,
  success: 27,
  progress: 28,
  log: 29,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  alert: 60,
  silent: Number.POSITIVE_INFINITY,
};
type Method = Exclude<keyof Logger, "level" | "clear" | "child">;

function safeBindings(value: Record<string, unknown>): Record<string, unknown> {
  const clean = redactTrailingArgs([value])[0];
  return clean !== null && typeof clean === "object" && !Array.isArray(clean)
    ? (clean as Record<string, unknown>)
    : { redactionError: REDACTION_FAILED_VALUE };
}

/** Creates a console-backed logger using the runtime's call and binding contract. */
export function createLogger(
  bindings: LoggerBindings | boolean = false,
): Logger {
  const clean =
    typeof bindings === "object" && bindings !== null
      ? safeBindings(bindings)
      : {};
  const { level, maxMemoryLogs: _maxMemoryLogs, ...base } = clean;
  const configuredLevel =
    typeof process !== "undefined" ? process.env?.LOG_LEVEL : undefined;
  let currentLevel =
    typeof level === "string"
      ? level.toLowerCase()
      : (configuredLevel || "info").toLowerCase();
  let sinkWarningSent = false;
  const invoke =
    (method: Method): Logger["info"] =>
    (obj, msg, ...args) => {
      if (priorities[method] < (priorities[currentLevel] ?? priorities.info))
        return;
      const sink =
        method === "fatal" || method === "error"
          ? "error"
          : method === "warn"
            ? "warn"
            : method === "trace" || method === "debug"
              ? "debug"
              : "info";
      const values = [obj, ...(msg === undefined ? [] : [msg]), ...args];
      const output = redactTrailingArgs(values);
      try {
        console[sink]({ ...base, level: method }, ...output);
      } catch {
        // error-policy:J7 Console failures must not break the renderer or leak the failed payload.
        if (!sinkWarningSent) {
          sinkWarningSent = true;
          try {
            console.error("[logger] Browser console sink failed");
          } catch {
            // error-policy:J7 A failed console cannot report its own failure.
          }
        }
      }
    };
  return {
    get level() {
      return currentLevel;
    },
    set level(value: string) {
      currentLevel = value.toLowerCase();
    },
    trace: invoke("trace"),
    debug: invoke("debug"),
    info: invoke("info"),
    warn: invoke("warn"),
    error: invoke("error"),
    fatal: invoke("fatal"),
    success: invoke("success"),
    progress: invoke("progress"),
    log: invoke("log"),
    child: (childBindings) =>
      createLogger({
        level: currentLevel,
        ...base,
        ...safeBindings(childBindings),
      }),
    clear: () => console.clear(),
  };
}

export const logger = createLogger();
export const elizaLogger = logger;
export default logger;
