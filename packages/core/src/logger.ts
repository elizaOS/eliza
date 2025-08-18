import { Sentry } from './sentry/instrument';

// Detect if we're in a browser environment - needs to be dynamic for testing
const getEnvironment = () => {
  const isBrowser = typeof globalThis !== 'undefined' && 
    typeof globalThis.window !== 'undefined' && 
    typeof globalThis.document !== 'undefined';
  const isNode = typeof process !== 'undefined' && 
    typeof process.versions !== 'undefined' && 
    typeof process.versions.node !== 'undefined';
  return { isBrowser, isNode };
};

// Local utility function to avoid circular dependency
function parseBooleanFromText(value: string | undefined | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

// Type definitions for cross-platform compatibility
type LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => void;

interface DestinationStream {
  write(data: string | LogEntry): void;
}

interface Logger {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  // Custom ElizaOS log levels
  success: LogFn;
  progress: LogFn;
  log: LogFn;
  clear: () => void;
  child: (bindings: Record<string, unknown>) => Logger;
  level?: string;
}

/**
 * Interface representing a log entry.
 * @property {number} [time] - The timestamp of the log entry.
 * @property {unknown} [key] - Additional properties that can be added to the log entry.
 */
/**
 * Interface representing a log entry.
 * @typedef {Object} LogEntry
 * @property {number} [time] - The time the log entry was created.
 * @property {string} key - The key for the log entry.
 * @property {unknown} value - The value associated with the key in the log entry.
 */
interface LogEntry {
  time?: number;
  level?: number | string;
  msg?: string;
  diagnostic?: boolean;
  agentName?: string;
  agentId?: string;
  [key: string]: unknown;
}

// Custom destination that maintains recent logs in memory
/**
 * Class representing an in-memory destination stream for logging.
 * Implements DestinationStream interface.
 */
class InMemoryDestination implements DestinationStream {
  private logs: LogEntry[] = [];
  private maxLogs = 1000; // Keep last 1000 logs
  private stream: DestinationStream | null;

  /**
   * Constructor for creating a new instance of the class.
   * @param {DestinationStream|null} stream - The stream to assign to the instance. Can be null.
   */
  constructor(stream: DestinationStream | null) {
    this.stream = stream;
  }

  /**
   * Writes a log entry to the memory buffer and forwards it to the pretty print stream if available.
   *
   * @param {string | LogEntry} data - The data to be written, which can be either a string or a LogEntry object.
   * @returns {void}
   */
  write(data: string | LogEntry): void {
    // Parse the log entry if it's a string
    let logEntry: LogEntry;
    let stringData: string;

    if (typeof data === 'string') {
      stringData = data;
      try {
        logEntry = JSON.parse(data);
      } catch (e) {
        // If it's not valid JSON, just pass it through
        if (this.stream) {
          this.stream.write(data);
        }
        return;
      }
    } else {
      logEntry = data;
      stringData = JSON.stringify(data);
    }

    // Add timestamp if not present
    if (!logEntry.time) {
      logEntry.time = Date.now();
    }

    // Filter out service registration logs unless in debug mode
    const isDebugMode = typeof process !== 'undefined' && 
      (process.env?.LOG_LEVEL || '').toLowerCase() === 'debug';
    const isLoggingDiagnostic = typeof process !== 'undefined' && 
      Boolean(process.env?.LOG_DIAGNOSTIC);

    if (isLoggingDiagnostic) {
      // When diagnostic mode is on, add a marker to every log to see what's being processed
      logEntry.diagnostic = true;
    }

    if (!isDebugMode) {
      // Check if this is a service or agent log that we want to filter
      if (logEntry.agentName && logEntry.agentId) {
        const msg = logEntry.msg || '';
        // Filter only service/agent registration logs, not all agent logs
        if (
          typeof msg === 'string' &&
          (msg.includes('registered successfully') ||
            msg.includes('Registering') ||
            msg.includes('Success:') ||
            msg.includes('linked to') ||
            msg.includes('Started'))
        ) {
          if (isLoggingDiagnostic) {
            if (typeof console !== 'undefined' && console.error) {
              console.error('Filtered log:', stringData);
            }
          }
          // This is a service registration/agent log, skip it
          return;
        }
      }
    }

    // Add to memory buffer
    this.logs.push(logEntry);

    // Maintain buffer size
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Forward to pretty print stream if available
    if (this.stream) {
      this.stream.write(stringData);
    }
  }

  /**
   * Retrieves the recent logs from the system.
   *
   * @returns {LogEntry[]} An array of LogEntry objects representing the recent logs.
   */
  recentLogs(): LogEntry[] {
    return this.logs;
  }

  /**
   * Clears all logs from memory.
   *
   * @returns {void}
   */
  clear(): void {
    this.logs = [];
  }
}

/**
 * Browser-compatible logger that mimics Pino's API but uses console.log
 */
// Define log level type and values
type LogLevelName = 'fatal' | 'error' | 'warn' | 'info' | 'log' | 'progress' | 'success' | 'debug' | 'trace';

interface BrowserLoggerOptions {
  level?: LogLevelName | string;
  base?: Record<string, unknown>;
}

class BrowserLogger implements Logger {
  private inMemoryDestination: InMemoryDestination;
  private currentLevel: number;
  private bindings: Record<string, unknown>;
  private levelValues: Record<LogLevelName, number> = {
    fatal: 60,
    error: 50,
    warn: 40,
    info: 30,
    log: 29,
    progress: 28,
    success: 27,
    debug: 20,
    trace: 10,
  };

  constructor(options: BrowserLoggerOptions = {}) {
    // Initialize in-memory logging
    this.inMemoryDestination = new InMemoryDestination(null);
    
    // Set log level
    const level = options.level || 'info';
    this.currentLevel = this.levelValues[level] || 30;
    this.level = level;
    
    // Store bindings for child loggers
    this.bindings = options.base || {};
  }

  level: string;

  private shouldLog(level: string): boolean {
    const levelValue = this.levelValues[level] || 30;
    return levelValue >= this.currentLevel;
  }

  private formatMessage(level: string, obj: unknown, msg?: string, ...args: unknown[]): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const levelLabel = level.toUpperCase();
    
    // Create log entry for in-memory storage
    const logEntry: LogEntry = {
      time: Date.now(),
      level: this.levelValues[level],
      msg: '',
      ...this.bindings
    };

    // Process arguments similar to pino
    let messageStr = '';
    let contextObj: Record<string, unknown> = {};

    if (typeof obj === 'string') {
      messageStr = obj;
      if (msg) {
        messageStr += ' ' + msg;
      }
      if (args.length > 0) {
        messageStr += ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      }
    } else if (obj instanceof Error) {
      contextObj = { error: { message: obj.message, stack: obj.stack } };
      messageStr = msg || obj.message;
    } else if (typeof obj === 'object' && obj !== null) {
      contextObj = obj as Record<string, unknown>;
      messageStr = msg || '';
      if (args.length > 0) {
        messageStr += ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      }
    }

    // Update log entry
    Object.assign(logEntry, contextObj);
    logEntry.msg = messageStr;

    // Store in memory
    this.inMemoryDestination.write(logEntry);

    // Format for console output
    const prefix = `[${timestamp}] ${levelLabel}:`;
    const hasContext = Object.keys(contextObj).length > 0;
    
    // Choose appropriate console method
    const consoleMethod = this.getConsoleMethod(level);

    // Log to console
    if (hasContext) {
      if (messageStr) {
        consoleMethod(prefix, messageStr, contextObj);
      } else {
        consoleMethod(prefix, contextObj);
      }
    } else if (messageStr) {
      consoleMethod(prefix, messageStr);
    }

    // Handle Sentry logging if needed
    if (typeof process !== 'undefined' && process.env?.SENTRY_LOGGING !== 'false') {
      if (obj instanceof Error || (level === 'error' || level === 'fatal')) {
        const error = obj instanceof Error ? obj : new Error(messageStr);
        Sentry.captureException(error);
      }
    }
  }

  private getConsoleMethod(level: string): (...args: unknown[]) => void {
    // Use globalThis.console for better test compatibility
    const consoleObj = (typeof globalThis !== 'undefined' && globalThis.console) ? globalThis.console :
                       (typeof console !== 'undefined' ? console : null);
    
    if (!consoleObj) {
      return () => {}; // No-op if console doesn't exist
    }

    // Fallback to console.log if specific methods don't exist
    const fallback = consoleObj.log ? consoleObj.log.bind(consoleObj) : () => {};

    switch (level) {
      case 'trace':
      case 'debug':
        return consoleObj.debug ? consoleObj.debug.bind(consoleObj) : fallback;
      case 'info':
      case 'log':
      case 'progress':
      case 'success':
        return consoleObj.info ? consoleObj.info.bind(consoleObj) : fallback;
      case 'warn':
        return consoleObj.warn ? consoleObj.warn.bind(consoleObj) : fallback;
      case 'error':
      case 'fatal':
        return consoleObj.error ? consoleObj.error.bind(consoleObj) : fallback;
      default:
        return fallback;
    }
  }

  trace: LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => {
    this.formatMessage('trace', obj, msg, ...args);
  };

  debug: LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => {
    this.formatMessage('debug', obj, msg, ...args);
  };

  info: LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => {
    this.formatMessage('info', obj, msg, ...args);
  };

  warn: LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => {
    this.formatMessage('warn', obj, msg, ...args);
  };

  error: LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => {
    this.formatMessage('error', obj, msg, ...args);
  };

  fatal: LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => {
    this.formatMessage('fatal', obj, msg, ...args);
  };

  // Custom log levels for ElizaOS compatibility
  success: LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => {
    this.formatMessage('success', obj, msg, ...args);
  };

  progress: LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => {
    this.formatMessage('progress', obj, msg, ...args);
  };

  log: LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => {
    this.formatMessage('log', obj, msg, ...args);
  };

  clear(): void {
    this.inMemoryDestination.clear();
    // Check if console.clear exists before calling it
    if (typeof globalThis !== 'undefined' && globalThis.console && globalThis.console.clear) {
      globalThis.console.clear();
    }
  }

  child(bindings: Record<string, unknown>): Logger {
    return new BrowserLogger({
      level: this.level,
      base: { ...this.bindings, ...bindings }
    });
  }
}

const customLevels: Record<string, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  log: 29,
  progress: 28,
  success: 27,
  debug: 20,
  trace: 10,
};

const raw = typeof process !== 'undefined' 
  ? parseBooleanFromText(process.env?.LOG_JSON_FORMAT) || false
  : false;

// Set default log level to info to allow regular logs, but still filter service logs
const isDebugMode = typeof process !== 'undefined'
  ? (process.env?.LOG_LEVEL || '').toLowerCase() === 'debug'
  : false;
const effectiveLogLevel = isDebugMode ? 'debug' : 
  (typeof process !== 'undefined' ? process.env?.DEFAULT_LOG_LEVEL : null) || 'info';

// Check if user wants timestamps in logs (default: true)
const showTimestamps = typeof process !== 'undefined' && process.env?.LOG_TIMESTAMPS !== undefined
  ? parseBooleanFromText(process.env?.LOG_TIMESTAMPS)
  : true;

// Create a function to generate the pretty configuration
const createPrettyConfig = () => ({
  colorize: true,
  translateTime: showTimestamps ? 'yyyy-mm-dd HH:MM:ss' : false,
  ignore: showTimestamps ? 'pid,hostname' : 'pid,hostname,time',
  levelColors: {
    60: 'red', // fatal
    50: 'red', // error
    40: 'yellow', // warn
    30: 'blue', // info
    29: 'green', // log
    28: 'cyan', // progress
    27: 'greenBright', // success
    20: 'magenta', // debug
    10: 'grey', // trace
    '*': 'white', // default for any unspecified level
  },
  customPrettifiers: {
    level: (inputData: unknown) => {
      let level;
      if (typeof inputData === 'object' && inputData !== null) {
        const data = inputData as Record<string, unknown>;
        level = data.level || data.value;
      } else {
        level = inputData;
      }

      const levelNames: Record<number, string> = {
        10: 'TRACE',
        20: 'DEBUG',
        27: 'SUCCESS',
        28: 'PROGRESS',
        29: 'LOG',
        30: 'INFO',
        40: 'WARN',
        50: 'ERROR',
        60: 'FATAL',
      };

      if (typeof level === 'number') {
        return levelNames[level] || `LEVEL${level}`;
      }

      if (level === undefined || level === null) {
        return 'UNKNOWN';
      }

      return String(level).toUpperCase();
    },
    // Add a custom prettifier for error messages
    msg: (msg: string) => {
      // Replace "ERROR (TypeError):" pattern with just "ERROR:"
      return msg.replace(/ERROR \([^)]+\):/g, 'ERROR:');
    },
  },
  messageFormat: '{msg}',
});

// Create options with appropriate level
const options = {
  level: effectiveLogLevel, // Use more restrictive level unless in debug mode
  customLevels,
  hooks: {
    logMethod(inputArgs: [string | Record<string, unknown>, ...unknown[]], method: LogFn): void {
      const [arg1, ...rest] = inputArgs;
      if (typeof process !== 'undefined' && process.env?.SENTRY_LOGGING !== 'false') {
        if (arg1 instanceof Error) {
          Sentry.captureException(arg1);
        } else {
          for (const item of rest) {
            if (item instanceof Error) {
              Sentry.captureException(item);
            }
          }
        }
      }

      const formatError = (err: Error) => ({
        message: `(${err.name}) ${err.message}`,
        stack: err.stack?.split('\n').map((line) => line.trim()),
      });

      if (typeof arg1 === 'object') {
        if (arg1 instanceof Error) {
          method.apply(this, [
            {
              error: formatError(arg1),
            },
          ]);
        } else {
          const messageParts = rest.map((arg) =>
            typeof arg === 'string' ? arg : JSON.stringify(arg)
          );
          const message = messageParts.join(' ');
          method.apply(this, [arg1, message]);
        }
      } else {
        const context = {};
        const messageParts = [arg1, ...rest].map((arg) => {
          if (arg instanceof Error) {
            return formatError(arg);
          }
          return typeof arg === 'string' ? arg : arg;
        });
        const message = messageParts.filter((part) => typeof part === 'string').join(' ');
        const jsonParts = messageParts.filter((part) => typeof part === 'object');

        Object.assign(context, ...jsonParts);

        method.apply(this, [context, message]);
      }
    },
  },
};

// Create logger factory function that works in both environments
const createLogger = (bindings: Record<string, unknown> | boolean = false): Logger => {
  const { isBrowser, isNode } = getEnvironment();
  
  // Browser environment: use BrowserLogger
  if (isBrowser) {
    // Extract level if provided in bindings
    let level = effectiveLogLevel;
    let base = {};
    
    if (typeof bindings === 'object' && bindings !== null) {
      // Check if level is provided in bindings
      if ('level' in bindings) {
        level = bindings.level as string;
        // Remove level from base bindings
        const { level: _, ...rest } = bindings;
        base = rest;
      } else {
        base = bindings;
      }
    }
    
    const opts: BrowserLoggerOptions = {
      level,
      base
    };
    return new BrowserLogger(opts);
  }
  
  // Node.js environment: use Pino
  if (isNode) {
    try {
      // Dynamically import Pino only in Node.js
      const Pino = require('pino');
      const opts: Record<string, any> = { ...options }; // shallow copy, using any for Pino's dynamic options
      
      if (bindings) {
        opts.base = bindings; // shallow change
        opts.transport = {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: showTimestamps ? 'SYS:standard' : false,
            ignore: showTimestamps ? 'pid,hostname' : 'pid,hostname,time',
          },
        };
      }
      
      const pinoLogger = Pino(opts);
      
      // Add clear method for compatibility
      (pinoLogger as any).clear = () => {
        // For Pino, clear doesn't really apply, but we provide it for API compatibility
        if (typeof console !== 'undefined' && console.clear) {
          console.clear();
        }
      };
      
      // Add custom ElizaOS methods if not present
      if (!(pinoLogger as any).success) {
        (pinoLogger as any).success = pinoLogger.info.bind(pinoLogger);
      }
      if (!(pinoLogger as any).progress) {
        (pinoLogger as any).progress = pinoLogger.info.bind(pinoLogger);
      }
      if (!(pinoLogger as any).log) {
        (pinoLogger as any).log = pinoLogger.info.bind(pinoLogger);
      }
      
      return pinoLogger;
    } catch (e) {
      // Fallback to BrowserLogger if Pino is not available
      // Use globalThis.console to ensure console exists
      if (typeof globalThis !== 'undefined' && globalThis.console && globalThis.console.warn) {
        globalThis.console.warn('Pino not available, falling back to BrowserLogger');
      }
      
      // Extract level if provided in bindings
      let level = effectiveLogLevel;
      let base = {};
      
      if (typeof bindings === 'object' && bindings !== null) {
        if ('level' in bindings) {
          level = bindings.level as string;
          const { level: _, ...rest } = bindings;
          base = rest;
        } else {
          base = bindings;
        }
      }
      
      const opts = {
        level,
        base
      };
      return new BrowserLogger(opts);
    }
  }
  
  // Unknown environment: use BrowserLogger as safe fallback
  // Extract level if provided in bindings
  let level = effectiveLogLevel;
  let base = {};
  
  if (typeof bindings === 'object' && bindings !== null) {
    if ('level' in bindings) {
      level = bindings.level as string;
      const { level: _, ...rest } = bindings;
      base = rest;
    } else {
      base = bindings;
    }
  }
  
  const opts: BrowserLoggerOptions = {
    level,
    base
  };
  return new BrowserLogger(opts);
};

// Initialize logger based on environment
let logger: Logger;

// Get current environment
const currentEnv = getEnvironment();

if (currentEnv.isBrowser) {
  // Browser environment: use BrowserLogger
  logger = new BrowserLogger({
    level: effectiveLogLevel
  });
} else if (currentEnv.isNode) {
  // Node.js environment: use Pino with all the bells and whistles
  try {
    const Pino = require('pino');
    
    // Create the destination with in-memory logging
    let stream = null;
    
    if (!raw) {
      // Try to load pino-pretty synchronously
      try {
        const pretty = require('pino-pretty');
        stream = pretty(createPrettyConfig());
      } catch (e) {
        // pino-pretty not available, will use raw output
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('pino-pretty not available, using raw output');
        }
      }
    }
    
    // Create logger with or without pretty printing
    const destination = new InMemoryDestination(stream);
    logger = Pino(options, destination);
    
    // Store destination reference for clear method
    (logger as any)[Symbol.for('pino-destination')] = destination;
    
    // Add clear method to logger
    (logger as any).clear = () => {
      const dest = (logger as any)[Symbol.for('pino-destination')];
      if (dest instanceof InMemoryDestination) {
        dest.clear();
      }
    };
    
    // Add custom ElizaOS log methods for compatibility
    if (!(logger as any).success) {
      (logger as any).success = (logger as any).info.bind(logger);
    }
    if (!(logger as any).progress) {
      (logger as any).progress = (logger as any).info.bind(logger);
    }
    if (!(logger as any).log) {
      (logger as any).log = (logger as any).info.bind(logger);
    }
  } catch (e) {
    // Pino not available, fall back to BrowserLogger
    if (typeof globalThis !== 'undefined' && globalThis.console && globalThis.console.warn) {
      globalThis.console.warn('Pino not available in Node.js environment, falling back to BrowserLogger');
    }
    logger = new BrowserLogger({
      level: effectiveLogLevel
    });
  }
} else {
  // Unknown environment: use BrowserLogger as safe fallback
  logger = new BrowserLogger({
    level: effectiveLogLevel
  });
}

// Extend the logger type to include custom methods
export interface ElizaLogger extends Logger {
  success: LogFn;
  progress: LogFn;
  log: LogFn;
}

// Cast logger to include custom methods
const typedLogger = logger as ElizaLogger;

export { createLogger, typedLogger as logger };

// for backward compatibility
export const elizaLogger = typedLogger;

export default typedLogger;
