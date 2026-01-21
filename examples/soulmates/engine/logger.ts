type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  [key: string]: unknown;
}

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: LogContext;
  timestamp: string;
  module: string;
}

const formatLog = (entry: LogEntry): string => JSON.stringify(entry);

const log = (
  level: LogLevel,
  module: string,
  message: string,
  context?: LogContext,
): void => {
  const entry: LogEntry = {
    level,
    message,
    context,
    timestamp: new Date().toISOString(),
    module,
  };

  const output = formatLog(entry);

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
};

export const createLogger = (module: string) => ({
  debug: (message: string, context?: LogContext) =>
    log("debug", module, message, context),
  info: (message: string, context?: LogContext) =>
    log("info", module, message, context),
  warn: (message: string, context?: LogContext) =>
    log("warn", module, message, context),
  error: (message: string, context?: LogContext) =>
    log("error", module, message, context),
});

export type Logger = ReturnType<typeof createLogger>;
