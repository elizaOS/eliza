/**
 * Training Package Logger
 *
 * Simple console-based logger for the training package.
 * Provides consistent logging format across all training services.
 */

// biome-ignore lint/suspicious/noExplicitAny: LogData must accept arbitrary objects for logging
type LogData = Record<string, any> | string | Error | undefined;

function formatData(data: LogData): string {
  if (data instanceof Error) {
    return data.message;
  }
  if (typeof data === "object" && data !== null) {
    return JSON.stringify(data, null, 2);
  }
  return String(data);
}

export const logger = {
  info: (message: string, data?: LogData, context?: string) => {
    const prefix = context ? `[${context}] ` : "";
    if (data !== undefined) {
      console.log(`${prefix}[INFO] ${message}`, formatData(data));
    } else {
      console.log(`${prefix}[INFO] ${message}`);
    }
  },

  error: (message: string, data?: LogData, context?: string) => {
    const prefix = context ? `[${context}] ` : "";
    if (data !== undefined) {
      console.error(`${prefix}[ERROR] ${message}`, formatData(data));
    } else {
      console.error(`${prefix}[ERROR] ${message}`);
    }
  },

  warn: (message: string, data?: LogData, context?: string) => {
    const prefix = context ? `[${context}] ` : "";
    if (data !== undefined) {
      console.warn(`${prefix}[WARN] ${message}`, formatData(data));
    } else {
      console.warn(`${prefix}[WARN] ${message}`);
    }
  },

  debug: (message: string, data?: LogData, context?: string) => {
    if (process.env.DEBUG) {
      const prefix = context ? `[${context}] ` : "";
      if (data !== undefined) {
        console.log(`${prefix}[DEBUG] ${message}`, formatData(data));
      } else {
        console.log(`${prefix}[DEBUG] ${message}`);
      }
    }
  },
};
