// src/logger.ts

export class Logger {
  private readonly debugEnabled: boolean;

  constructor(debugEnabled: boolean) {
    this.debugEnabled = debugEnabled;
  }

  info(msg: string, ...args: any[]) {
    console.log(msg, ...args);
  }

  debug(msg: string, ...args: any[]) {
    if (this.debugEnabled) {
      console.log(msg, ...args);
    }
  }

  warn(msg: string, ...args: any[]) {
    console.warn('[WARN]', msg, ...args);
  }

  error(msg: string, ...args: any[]) {
    console.error(msg, ...args);
  }

  isDebugEnabled(): boolean {
    return this.debugEnabled;
  }
}
