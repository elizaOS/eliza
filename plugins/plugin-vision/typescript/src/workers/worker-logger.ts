import { parentPort } from 'worker_threads';

/**
 * Worker-safe logger that sends log messages to the main thread
 */
export const logger = {
  info: (message: string, ...args: any[]) => {
    const logMessage = {
      type: 'log',
      level: 'info',
      message,
      args,
      timestamp: new Date().toISOString(),
    };

    if (parentPort) {
      parentPort.postMessage(logMessage);
    } else {
      console.log(`[INFO] ${message}`, ...args);
    }
  },

  warn: (message: string, ...args: any[]) => {
    const logMessage = {
      type: 'log',
      level: 'warn',
      message,
      args,
      timestamp: new Date().toISOString(),
    };

    if (parentPort) {
      parentPort.postMessage(logMessage);
    } else {
      console.warn(`[WARN] ${message}`, ...args);
    }
  },

  error: (message: string, ...args: any[]) => {
    const logMessage = {
      type: 'log',
      level: 'error',
      message,
      args,
      timestamp: new Date().toISOString(),
    };

    if (parentPort) {
      parentPort.postMessage(logMessage);
    } else {
      console.error(`[ERROR] ${message}`, ...args);
    }
  },

  debug: (message: string, ...args: any[]) => {
    const logMessage = {
      type: 'log',
      level: 'debug',
      message,
      args,
      timestamp: new Date().toISOString(),
    };

    if (parentPort) {
      parentPort.postMessage(logMessage);
    } else {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  },
};
