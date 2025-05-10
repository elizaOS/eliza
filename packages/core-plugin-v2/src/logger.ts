import { logger as coreLogger } from '@elizaos/core';

// logger wrapper/specification
const logger: Record<
  | 'trace'
  | 'debug'
  | 'success'
  | 'progress'
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal'
  | 'clear',
  LogMethod
> = {
  trace: (...args) => coreLogger.trace(...args),
  debug: (...args) => coreLogger.debug(...args),
  success: (...args) => coreLogger.debug(...args),
  progress: (...args) => coreLogger.debug(...args),
  log: (...args) => coreLogger.info(...args),
  info: (...args) => coreLogger.info(...args),
  warn: (...args) => coreLogger.warn(...args),
  error: (...args) => coreLogger.error(...args),
  fatal: (...args) => coreLogger.fatal(...args),
  clear: () => coreLogger.clear(),
};

export { logger };

// for backward compatibility
// we should deprecate this
export const elizaLogger = logger;

export default logger;
