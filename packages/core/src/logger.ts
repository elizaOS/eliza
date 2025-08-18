import { Sentry } from './sentry/instrument';

// Detect if we're in a browser environment
const isBrowser = typeof globalThis !== 'undefined' && 
  typeof globalThis.window !== 'undefined' && 
  typeof globalThis.document !== 'undefined';
const isNode = typeof process !== 'undefined' && 
  typeof process.versions !== 'undefined' && 
  typeof process.versions.node !== 'undefined';

// Local utility function to avoid circular dependency
function parseBooleanFromText(value: string | undefined | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

// Type definitions for cross-platform compatibility
type LogFn = (obj: Record<string, any> | string, msg?: string, ...args: any[]) => void;

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
  clear?: () => void;
  child?: (bindings: Record<string, any>) => Logger;
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
    const isDebugMode = (process?.env?.LOG_LEVEL || '').toLowerCase() === 'debug';
    const isLoggingDiagnostic = Boolean(process?.env?.LOG_DIAGNOSTIC);

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
            console.error('Filtered log:', stringData);
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
class BrowserLogger implements Logger {
  private inMemoryDestination: InMemoryDestination;
  private currentLevel: number;
  private bindings: Record<string, any>;
  private levelValues: Record<string, number> = {
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

  constructor(options: any = {}) {
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

  private formatMessage(level: string, obj: any, msg?: string, ...args: any[]): void {
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
    let contextObj: Record<string, any> = {};

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
      contextObj = obj;
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

  private getConsoleMethod(level: string): (...args: any[]) => void {
    switch (level) {
      case 'trace':
      case 'debug':
        return console.debug.bind(console);
      case 'info':
      case 'log':
      case 'progress':
      case 'success':
        return console.info.bind(console);
      case 'warn':
        return console.warn.bind(console);
      case 'error':
      case 'fatal':
        return console.error.bind(console);
      default:
        return console.log.bind(console);
    }
  }

  trace: LogFn = (obj: any, msg?: string, ...args: any[]) => {
    this.formatMessage('trace', obj, msg, ...args);
  };

  debug: LogFn = (obj: any, msg?: string, ...args: any[]) => {
    this.formatMessage('debug', obj, msg, ...args);
  };

  info: LogFn = (obj: any, msg?: string, ...args: any[]) => {
    this.formatMessage('info', obj, msg, ...args);
  };

  warn: LogFn = (obj: any, msg?: string, ...args: any[]) => {
    this.formatMessage('warn', obj, msg, ...args);
  };

  error: LogFn = (obj: any, msg?: string, ...args: any[]) => {
    this.formatMessage('error', obj, msg, ...args);
  };

  fatal: LogFn = (obj: any, msg?: string, ...args: any[]) => {
    this.formatMessage('fatal', obj, msg, ...args);
  };

  clear(): void {
    this.inMemoryDestination.clear();
    console.clear();
  }

  child(bindings: Record<string, any>): Logger {
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

const raw = parseBooleanFromText(process?.env?.LOG_JSON_FORMAT) || false;

// Set default log level to info to allow regular logs, but still filter service logs
const isDebugMode = (process?.env?.LOG_LEVEL || '').toLowerCase() === 'debug';
const effectiveLogLevel = isDebugMode ? 'debug' : process?.env?.DEFAULT_LOG_LEVEL || 'info';

// Check if user wants timestamps in logs (default: true)
const showTimestamps =
  process?.env?.LOG_TIMESTAMPS !== undefined
    ? parseBooleanFromText(process?.env?.LOG_TIMESTAMPS)
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
    level: (inputData: any) => {
      let level;
      if (typeof inputData === 'object' && inputData !== null) {
        level = inputData.level || inputData.value;
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
      if (process.env.SENTRY_LOGGING !== 'false') {
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
const createLogger = (bindings: any | boolean = false): Logger => {
  // Browser environment: use BrowserLogger
  if (isBrowser) {
    const opts: any = {
      level: effectiveLogLevel,
      base: typeof bindings === 'object' ? bindings : {}
    };
    return new BrowserLogger(opts);
  }
  
  // Node.js environment: use Pino
  if (isNode) {
    try {
      // Dynamically import Pino only in Node.js
      const Pino = require('pino');
      const opts: any = { ...options }; // shallow copy
      
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
      
      return Pino(opts);
    } catch (e) {
      // Fallback to BrowserLogger if Pino is not available
      console.warn('Pino not available, falling back to BrowserLogger');
      const opts: any = {
        level: effectiveLogLevel,
        base: typeof bindings === 'object' ? bindings : {}
      };
      return new BrowserLogger(opts);
    }
  }
  
  // Unknown environment: use BrowserLogger as safe fallback
  const opts: any = {
    level: effectiveLogLevel,
    base: typeof bindings === 'object' ? bindings : {}
  };
  return new BrowserLogger(opts);
};

// Initialize logger based on environment
let logger: Logger;

if (isBrowser) {
  // Browser environment: use BrowserLogger
  logger = new BrowserLogger({
    level: effectiveLogLevel
  });
} else if (isNode) {
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
        console.warn('pino-pretty not available, using raw output');
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
  } catch (e) {
    // Pino not available, fall back to BrowserLogger
    console.warn('Pino not available in Node.js environment, falling back to BrowserLogger');
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

export { createLogger, logger };

// for backward compatibility
export const elizaLogger = logger;

export default logger;
