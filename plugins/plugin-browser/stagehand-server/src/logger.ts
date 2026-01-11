export class Logger {
  private prefix = "[StagehandServer]";

  info(message: string, ...args: unknown[]) {
    console.log(`${this.prefix} INFO:`, message, ...args);
  }

  debug(message: string, ...args: unknown[]) {
    if (process.env.DEBUG) {
      console.log(`${this.prefix} DEBUG:`, message, ...args);
    }
  }

  error(message: string, error?: unknown) {
    console.error(`${this.prefix} ERROR:`, message, error);
  }

  warn(message: string, ...args: unknown[]) {
    console.warn(`${this.prefix} WARN:`, message, ...args);
  }
}
