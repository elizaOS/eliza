import { Sentry } from './sentry/instrument';

// Singleton environment detector with cached results
class EnvironmentDetector {
  private static instance: EnvironmentDetector;
  private cachedResult: { isBrowser: boolean; isNode: boolean } | null = null;
  
  private constructor() {}
  
  static getInstance(): EnvironmentDetector {
    if (!EnvironmentDetector.instance) {
      EnvironmentDetector.instance = new EnvironmentDetector();
    }
    return EnvironmentDetector.instance;
  }
  
  getEnvironment(): { isBrowser: boolean; isNode: boolean } {
    // Return cached result if available (for performance)
    if (this.cachedResult !== null) {
      return this.cachedResult;
    }
    
    const isBrowser = typeof globalThis !== 'undefined' && 
      typeof globalThis.window !== 'undefined' && 
      typeof globalThis.document !== 'undefined';
    const isNode = typeof process !== 'undefined' && 
      typeof process.versions !== 'undefined' && 
      typeof process.versions.node !== 'undefined';
    
    this.cachedResult = { isBrowser, isNode };
    return this.cachedResult;
  }
  
  // Clear cache for testing purposes
  clearCache(): void {
    this.cachedResult = null;
  }
  
  // Helper methods for common checks
  isNode(): boolean {
    return this.getEnvironment().isNode;
  }
  
  isBrowser(): boolean {
    return this.getEnvironment().isBrowser;
  }
  
  hasProcess(): boolean {
    return typeof process !== 'undefined';
  }
  
  getProcessEnv(key: string): string | undefined {
    if (this.hasProcess() && process.env) {
      return process.env[key];
    }
    return undefined;
  }
}

// Create singleton instance
const envDetector = EnvironmentDetector.getInstance();

// Convenience function for backward compatibility
const getEnvironment = () => envDetector.getEnvironment();

// Local utility function to avoid circular dependency
function parseBooleanFromText(value: string | undefined | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

// Utility function for safe console access
function getConsole(): Console | null {
  if (typeof globalThis !== 'undefined' && globalThis.console) {
    return globalThis.console;
  }
  if (typeof console !== 'undefined') {
    return console;
  }
  return null;
}

// Utility function to safely stringify objects with circular references
function safeStringify(obj: unknown): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
  } catch (error) {
    // Fallback for any other stringify errors
    return String(obj);
  }
}

/**
 * Module Loading Strategy:
 * 
 * This module provides both synchronous and asynchronous logger factory functions
 * to support a gradual migration from CommonJS to ES modules:
 * 
 * 1. createLogger() - Synchronous, uses require() via sync loaders (backward compatible)
 * 2. createLoggerAsync() - Asynchronous, uses dynamic import() (recommended for new code)
 * 
 * The module loaders cache loaded modules to avoid redundant imports and improve performance.
 * 
 * Migration path:
 * - Existing code can continue using createLogger()
 * - New code should prefer createLoggerAsync() for full ES module support
 * - Future versions will deprecate the synchronous version
 */

// Module loader cache for dynamic imports
interface ModuleCache {
  pinoPromise?: Promise<any>;
  pinoPrettyPromise?: Promise<any>;
  pino?: any;
  pinoPretty?: any;
}

const moduleCache: ModuleCache = {};

// Async module loader for Pino
async function loadPinoAsync(): Promise<any> {
  if (moduleCache.pino) {
    return moduleCache.pino;
  }
  
  if (!moduleCache.pinoPromise) {
    moduleCache.pinoPromise = import('pino').then(module => {
      moduleCache.pino = module.default || module;
      return moduleCache.pino;
    });
  }
  
  return moduleCache.pinoPromise;
}

// Async module loader for pino-pretty
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function loadPinoPrettyAsync(): Promise<any> {
  if (moduleCache.pinoPretty) {
    return moduleCache.pinoPretty;
  }
  
  if (!moduleCache.pinoPrettyPromise) {
    moduleCache.pinoPrettyPromise = import('pino-pretty').then(module => {
      moduleCache.pinoPretty = module.default || module;
      return moduleCache.pinoPretty;
    });
  }
  
  return moduleCache.pinoPrettyPromise;
}

// Synchronous fallback loaders (using require) for backward compatibility
// These will be used in createLogger until we can refactor to async
function loadPinoSync(): any {
  if (moduleCache.pino) {
    return moduleCache.pino;
  }
  
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require('pino');
    moduleCache.pino = module;
    return module;
  } catch (error) {
    throw new Error(`Failed to load Pino: ${(error as Error).message}`);
  }
}

function loadPinoPrettySync(): any {
  if (moduleCache.pinoPretty) {
    return moduleCache.pinoPretty;
  }
  
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require('pino-pretty');
    moduleCache.pinoPretty = module;
    return module;
  } catch (error) {
    // pino-pretty is optional, so we can continue without it
    return null;
  }
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

// Symbol for storing the destination reference
const PINO_DESTINATION_SYMBOL = Symbol.for('pino-destination');

// Extended Logger interface for Pino with custom properties
interface ExtendedPinoLogger extends Logger {
  [key: symbol]: InMemoryDestination | undefined;
}

// Pino configuration types
interface PinoTransportOptions {
  target: string;
  options: {
    colorize: boolean;
    translateTime: string | false;
    ignore: string;
  };
}

interface PinoOptions {
  level: string;
  customLevels: Record<string, number>;
  base?: Record<string, unknown>;
  transport?: PinoTransportOptions;
  hooks?: {
    logMethod: (inputArgs: [string | Record<string, unknown>, ...unknown[]], method: LogFn) => void;
  };
}

/**
 * Interface representing a log entry.
 * @property time - The timestamp of the log entry
 * @property level - The log level as a number or string
 * @property msg - The log message content
 * @property diagnostic - Flag indicating if this is a diagnostic log
 * @property agentName - Name of the agent that created the log
 * @property agentId - ID of the agent that created the log
 * @property [key: string] - Additional properties that can be added to the log entry
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
      stringData = safeStringify(data);
    }

    // Add timestamp if not present
    if (!logEntry.time) {
      logEntry.time = Date.now();
    }

    // Filter out service registration logs unless in debug mode
    const isDebugMode = envDetector.hasProcess() && 
      (envDetector.getProcessEnv('LOG_LEVEL') || '').toLowerCase() === 'debug';
    const isLoggingDiagnostic = envDetector.hasProcess() && 
      Boolean(envDetector.getProcessEnv('LOG_DIAGNOSTIC'));

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
            const consoleObj = getConsole();
            if (consoleObj && consoleObj.error) {
              consoleObj.error('Filtered log:', stringData);
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
        messageStr += ' ' + args.map(a => typeof a === 'object' ? safeStringify(a) : String(a)).join(' ');
      }
    } else if (obj instanceof Error) {
      contextObj = { error: { message: obj.message, stack: obj.stack } };
      messageStr = msg || obj.message;
    } else if (typeof obj === 'object' && obj !== null) {
      contextObj = obj as Record<string, unknown>;
      messageStr = msg || '';
      if (args.length > 0) {
        messageStr += ' ' + args.map(a => typeof a === 'object' ? safeStringify(a) : String(a)).join(' ');
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
    if (envDetector.hasProcess() && envDetector.getProcessEnv('SENTRY_LOGGING') !== 'false') {
      if (obj instanceof Error || (level === 'error' || level === 'fatal')) {
        const error = obj instanceof Error ? obj : new Error(messageStr);
        Sentry.captureException(error);
      }
    }
  }

  private getConsoleMethod(level: string): (...args: unknown[]) => void {
    const consoleObj = getConsole();
    
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
    const consoleObj = getConsole();
    if (consoleObj && consoleObj.clear) {
      consoleObj.clear();
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

const raw = envDetector.hasProcess()
  ? parseBooleanFromText(envDetector.getProcessEnv('LOG_JSON_FORMAT')) || false
  : false;

// Set default log level to info to allow regular logs, but still filter service logs
const isDebugMode = envDetector.hasProcess()
  ? (envDetector.getProcessEnv('LOG_LEVEL') || '').toLowerCase() === 'debug'
  : false;
const effectiveLogLevel = isDebugMode ? 'debug' : 
  (envDetector.hasProcess() ? envDetector.getProcessEnv('DEFAULT_LOG_LEVEL') : null) || 'info';

// Check if user wants timestamps in logs (default: true)
const showTimestamps = envDetector.hasProcess() && envDetector.getProcessEnv('LOG_TIMESTAMPS') !== undefined
  ? parseBooleanFromText(envDetector.getProcessEnv('LOG_TIMESTAMPS'))
  : true;

// Utility function to extract level and base from bindings
function extractBindingsConfig(bindings: Record<string, unknown> | boolean): {
  level: string;
  base: Record<string, unknown>;
} {
  let level = effectiveLogLevel;
  let base: Record<string, unknown> = {};
  
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
  
  return { level, base };
}

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
      if (envDetector.hasProcess() && envDetector.getProcessEnv('SENTRY_LOGGING') !== 'false') {
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
            typeof arg === 'string' ? arg : safeStringify(arg)
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

// Async logger factory function using dynamic imports (recommended for new code)
const createLoggerAsync = async (bindings: Record<string, unknown> | boolean = false): Promise<Logger> => {
  // Check for test environment flag to force BrowserLogger
  const forceType = typeof bindings === 'object' && bindings !== null 
    ? (bindings as any).__forceType 
    : undefined;
    
  if (forceType === 'browser') {
    // Remove __forceType from bindings before passing to BrowserLogger
    const { __forceType, ...cleanBindings } = bindings as any;
    const { level, base } = extractBindingsConfig(cleanBindings);
    const opts: BrowserLoggerOptions = {
      level,
      base
    };
    return new BrowserLogger(opts);
  }
  
  const { isBrowser, isNode } = getEnvironment();
  
  // Browser environment: use BrowserLogger
  if (isBrowser) {
    const { level, base } = extractBindingsConfig(bindings);
    const opts: BrowserLoggerOptions = {
      level,
      base
    };
    return new BrowserLogger(opts);
  }
  
  // Node.js environment: use Pino with dynamic imports
  if (isNode) {
    try {
      // Load Pino module using dynamic import
      const Pino = await loadPinoAsync();
      const opts: PinoOptions = { ...options } as PinoOptions;
      
      if (bindings && typeof bindings === 'object') {
        opts.base = bindings;
        opts.transport = {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: showTimestamps ? 'SYS:standard' : false,
            ignore: showTimestamps ? 'pid,hostname' : 'pid,hostname,time',
          },
        };
      }
      
      const pinoLogger = Pino(opts) as ExtendedPinoLogger;
      
      // Add custom log levels
      pinoLogger.clear = pinoLogger.info.bind(pinoLogger);
      pinoLogger.success = pinoLogger.info.bind(pinoLogger);
      pinoLogger.progress = pinoLogger.info.bind(pinoLogger);
      pinoLogger.log = pinoLogger.info.bind(pinoLogger);
      
      return pinoLogger;
    } catch (error) {
      // Fallback to BrowserLogger if Pino is not available
      const consoleObj = getConsole();
      if (consoleObj && consoleObj.warn) {
        consoleObj.warn('Pino not available, falling back to BrowserLogger:', error);
      }
      const { level, base } = extractBindingsConfig(bindings);
      const opts: BrowserLoggerOptions = {
        level,
        base
      };
      return new BrowserLogger(opts);
    }
  }
  
  // Default fallback
  const { level, base } = extractBindingsConfig(bindings);
  const opts: BrowserLoggerOptions = {
    level,
    base
  };
  return new BrowserLogger(opts);
};

// Synchronous logger factory function (for backward compatibility)
// Uses require() through sync loaders, will be deprecated in future versions
const createLogger = (bindings: Record<string, unknown> | boolean = false): Logger => {
  // Check for test environment flag to force BrowserLogger
  const forceType = typeof bindings === 'object' && bindings !== null 
    ? (bindings as any).__forceType 
    : undefined;
    
  if (forceType === 'browser') {
    // Remove __forceType from bindings before passing to BrowserLogger
    const { __forceType, ...cleanBindings } = bindings as any;
    const { level, base } = extractBindingsConfig(cleanBindings);
    const opts: BrowserLoggerOptions = {
      level,
      base
    };
    return new BrowserLogger(opts);
  }
  
  const { isBrowser, isNode } = getEnvironment();
  
  // Browser environment: use BrowserLogger
  if (isBrowser) {
    const { level, base } = extractBindingsConfig(bindings);
    const opts: BrowserLoggerOptions = {
      level,
      base
    };
    return new BrowserLogger(opts);
  }
  
  // Node.js environment: use Pino
  if (isNode) {
    try {
      // Load Pino module (uses cached version if available)
      const Pino = loadPinoSync();
      const opts: PinoOptions = { ...options } as PinoOptions;
      
      if (bindings && typeof bindings === 'object') {
        opts.base = bindings;
        opts.transport = {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: showTimestamps ? 'SYS:standard' : false,
            ignore: showTimestamps ? 'pid,hostname' : 'pid,hostname,time',
          },
        };
      }
      
      const pinoLogger = Pino(opts) as ExtendedPinoLogger;
      
      // Add clear method for compatibility
      pinoLogger.clear = () => {
        // For Pino, clear doesn't really apply, but we provide it for API compatibility
        const consoleObj = getConsole();
        if (consoleObj && consoleObj.clear) {
          consoleObj.clear();
        }
      };
      
      // Add custom ElizaOS methods if not present
      if (!pinoLogger.success) {
        pinoLogger.success = pinoLogger.info.bind(pinoLogger);
      }
      if (!pinoLogger.progress) {
        pinoLogger.progress = pinoLogger.info.bind(pinoLogger);
      }
      if (!pinoLogger.log) {
        pinoLogger.log = pinoLogger.info.bind(pinoLogger);
      }
      
      return pinoLogger;
    } catch (e) {
      // Fallback to BrowserLogger if Pino is not available
      const consoleObj = getConsole();
      if (consoleObj && consoleObj.warn) {
        consoleObj.warn('Pino not available, falling back to BrowserLogger');
      }
      
      const { level, base } = extractBindingsConfig(bindings);
      const opts = {
        level,
        base
      };
      return new BrowserLogger(opts);
    }
  }
  
  // Unknown environment: use BrowserLogger as safe fallback
  const { level, base } = extractBindingsConfig(bindings);
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
    const Pino = loadPinoSync();
    
    // Create the destination with in-memory logging
    let stream = null;
    
    if (!raw) {
      // Try to load pino-pretty synchronously
      const pretty = loadPinoPrettySync();
      if (pretty) {
        stream = pretty(createPrettyConfig());
      } else {
        // pino-pretty not available, will use raw output
        const consoleObj = getConsole();
        if (consoleObj && consoleObj.warn) {
          consoleObj.warn('pino-pretty not available, using raw output');
        }
      }
    }
    
    // Create logger with or without pretty printing
    const destination = new InMemoryDestination(stream);
    const pinoLogger = Pino(options, destination) as ExtendedPinoLogger;
    
    // Store destination reference for clear method
    pinoLogger[PINO_DESTINATION_SYMBOL] = destination;
    
    // Add clear method to logger
    pinoLogger.clear = () => {
      const dest = pinoLogger[PINO_DESTINATION_SYMBOL];
      if (dest instanceof InMemoryDestination) {
        dest.clear();
      }
    };
    
    // Add custom ElizaOS log methods for compatibility
    if (!pinoLogger.success) {
      pinoLogger.success = pinoLogger.info.bind(pinoLogger);
    }
    if (!pinoLogger.progress) {
      pinoLogger.progress = pinoLogger.info.bind(pinoLogger);
    }
    if (!pinoLogger.log) {
      pinoLogger.log = pinoLogger.info.bind(pinoLogger);
    }
    
    logger = pinoLogger;
  } catch (e) {
    // Pino not available, fall back to BrowserLogger
    const consoleObj = getConsole();
    if (consoleObj && consoleObj.warn) {
      consoleObj.warn('Pino not available in Node.js environment, falling back to BrowserLogger');
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

export { createLogger, createLoggerAsync, typedLogger as logger };

// for backward compatibility
export const elizaLogger = typedLogger;

// Export envDetector for testing purposes
export { envDetector };

export default typedLogger;
