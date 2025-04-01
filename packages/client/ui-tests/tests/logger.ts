/**
 * Logger wrapper for UI tests
 *
 * This provides a consistent interface to use the @elizaos/core logger when available,
 * with fallback to console methods to make tests resilient against import issues.
 */

// Import types from @elizaos/core but don't require the import to succeed
import type { UUID } from '@elizaos/core';

// Try to import from core, but provide fallbacks if not available
let coreLogger: any;

// Use asynchronous import to properly load the logger
(async () => {
  try {
    // Try importing using the ESM dynamic import
    const core = await import('@elizaos/core');
    coreLogger = core.logger;

    if (!coreLogger) {
      throw new Error('Logger not found in @elizaos/core');
    }
  } catch (e) {
    console.warn(
      'Could not import logger from @elizaos/core, using console fallback:',
      e instanceof Error ? e.message : e
    );
    coreLogger = null;
  }
})();

// Logger interface definition for better type checking
interface Logger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

// Create a logger object that either uses the core logger or falls back to console
export const logger: Logger = {
  info: (...args: any[]) => {
    if (coreLogger) {
      try {
        coreLogger.info(...args);
      } catch (e) {
        console.info('[INFO]', ...args);
      }
    } else {
      console.info('[INFO]', ...args);
    }
  },

  debug: (...args: any[]) => {
    if (coreLogger) {
      try {
        coreLogger.debug(...args);
      } catch (e) {
        console.debug('[DEBUG]', ...args);
      }
    } else {
      console.debug('[DEBUG]', ...args);
    }
  },

  warn: (...args: any[]) => {
    if (coreLogger) {
      try {
        coreLogger.warn(...args);
      } catch (e) {
        console.warn('[WARN]', ...args);
      }
    } else {
      console.warn('[WARN]', ...args);
    }
  },

  error: (...args: any[]) => {
    if (coreLogger) {
      try {
        coreLogger.error(...args);
      } catch (e) {
        console.error('[ERROR]', ...args);
      }
    } else {
      console.error('[ERROR]', ...args);
    }
  },

  log: (...args: any[]) => {
    if (coreLogger) {
      try {
        coreLogger.log(...args);
      } catch (e) {
        console.log('[LOG]', ...args);
      }
    } else {
      console.log('[LOG]', ...args);
    }
  },
};

export default logger;
