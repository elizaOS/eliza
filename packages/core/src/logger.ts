import { Sentry } from './sentry/instrument';

// ============================================================================
// Environment Detection
// ============================================================================

// Factory function to create environment detector with cached results
function createEnvironmentDetector() {
  let cachedResult: { isBrowser: boolean; isNode: boolean } | null = null;
  
  const getEnvironment = (): { isBrowser: boolean; isNode: boolean } => {
    // Return cached result if available (for performance)
    if (cachedResult !== null) {
      return cachedResult;
    }
    
    const isBrowser = typeof globalThis !== 'undefined' && 
      typeof globalThis.window !== 'undefined' && 
      typeof globalThis.document !== 'undefined';
    const isNode = typeof process !== 'undefined' && 
      typeof process.versions !== 'undefined' && 
      typeof process.versions.node !== 'undefined';
    
    cachedResult = { isBrowser, isNode };
    return cachedResult;
  };
  
  const clearCache = (): void => {
    cachedResult = null;
  };
  
  const isNode = (): boolean => {
    return getEnvironment().isNode;
  };
  
  const isBrowser = (): boolean => {
    return getEnvironment().isBrowser;
  };
  
  const hasProcess = (): boolean => {
    return typeof process !== 'undefined';
  };
  
  const getProcessEnv = (key: string): string | undefined => {
    if (hasProcess() && process.env) {
      return process.env[key];
    }
    return undefined;
  };
  
  return {
    getEnvironment,
    clearCache,
    isNode,
    isBrowser,
    hasProcess,
    getProcessEnv
  };
}

// Create singleton instance
const envDetector = createEnvironmentDetector();

// Convenience function for backward compatibility
const getEnvironment = () => envDetector.getEnvironment();

// ============================================================================
// Utility Functions
// ============================================================================

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

// ============================================================================
// Module Loading Strategy
// ============================================================================
// This module provides both synchronous and asynchronous logger factory functions
// to support a gradual migration from CommonJS to ES modules:
// 
// 1. createLogger() - Synchronous, uses require() via sync loaders (backward compatible)
// 2. createLoggerAsync() - Asynchronous, uses dynamic import() (recommended for new code)
// 
// The module loaders cache loaded modules to avoid redundant imports and improve performance.

// ============================================================================
// Type Definitions
// ============================================================================
type PinoModule = {
  default?: unknown;
  (options?: PinoOptions, destination?: NodeJS.WritableStream | unknown): unknown;
  destination?: unknown;
  transport?: unknown;
  stdTimeFunctions?: unknown;
  levels?: unknown;
  symbols?: unknown;
  pino?: unknown;
  multistream?: unknown;
  stdSerializers?: unknown;
};

type PinoPrettyModule = {
  default?: unknown;
  (options?: object): NodeJS.WritableStream;
  build?: unknown;
  PinoPretty?: unknown;
  colorizerFactory?: unknown;
  prettyFactory?: unknown;
};

interface ModuleCache {
  pinoPromise?: Promise<PinoModule>;
  pinoPrettyPromise?: Promise<PinoPrettyModule>;
  pino?: PinoModule;
  pinoPretty?: PinoPrettyModule;
}

const moduleCache: ModuleCache = {};

// Async module loader for Pino
async function loadPinoAsync(): Promise<PinoModule> {
  if (moduleCache.pino) {
    return moduleCache.pino;
  }
  
  if (!moduleCache.pinoPromise) {
    moduleCache.pinoPromise = import('pino').then(module => {
      moduleCache.pino = (module.default || module) as PinoModule;
      return moduleCache.pino;
    });
  }
  
  return moduleCache.pinoPromise;
}

// ============================================================================
// Module Loaders
// ============================================================================
function loadPinoSync(): PinoModule {
  if (moduleCache.pino) {
    return moduleCache.pino;
  }
  
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require('pino');
    moduleCache.pino = module as PinoModule;
    return module as PinoModule;
  } catch (error) {
    throw new Error(`Failed to load Pino: ${(error as Error).message}`);
  }
}

function loadPinoPrettySync(): PinoPrettyModule | null {
  if (moduleCache.pinoPretty) {
    return moduleCache.pinoPretty;
  }
  
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require('pino-pretty');
    moduleCache.pinoPretty = module as PinoPrettyModule;
    return module as PinoPrettyModule;
  } catch (error) {
    // pino-pretty is optional, so we can continue without it
    return null;
  }
}

// Type definitions for cross-platform compatibility
type LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => void;

// Type for logger bindings with optional test override
interface LoggerBindings extends Record<string, unknown> {
  __forceType?: 'browser' | 'node';
  level?: string;
}

interface DestinationStream {
  write(data: string | LogEntry): void;
  recentLogs?(): LogEntry[];
  clear?(): void;
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
  [key: symbol]: DestinationStream | undefined;
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

// ============================================================================
// In-Memory Destination
// ============================================================================

/**
 * Factory function for creating an in-memory destination stream for logging.
 * Returns object implementing DestinationStream interface.
 */
function createInMemoryDestination(stream: DestinationStream | null): DestinationStream {
  let logs: LogEntry[] = [];
  const maxLogs = 1000; // Keep last 1000 logs

  const write = (data: string | LogEntry): void => {
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
    logs.push(logEntry);

    // Maintain buffer size
    if (logs.length > maxLogs) {
      logs.shift();
    }

    // Forward to pretty print stream if available
    if (stream) {
      stream.write(stringData);
    }
  };

  const recentLogs = (): LogEntry[] => logs;
  const clear = (): void => { logs = []; };
  
  // Return object implementing DestinationStream interface
  return {
    write,
    recentLogs,
    clear
  };
}

// ============================================================================
// Browser Logger Implementation
// ============================================================================

/**
 * Factory function to create browser-compatible logger that mimics Pino's API but uses console.log
 */
// Define log level type and values
type LogLevelName = 'fatal' | 'error' | 'warn' | 'info' | 'log' | 'progress' | 'success' | 'debug' | 'trace';

interface BrowserLoggerOptions {
  level?: LogLevelName | string;
  base?: Record<string, unknown>;
}

// Level values configuration
const levelValues: Record<LogLevelName, number> = {
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

function createBrowserLogger(options: BrowserLoggerOptions = {}): Logger {
  // Initialize in-memory logging
  const inMemoryDestination = createInMemoryDestination(null);
  
  // Set log level
  const level = options.level || 'info';
  const currentLevel = levelValues[level as LogLevelName] || 30;
  
  // Store bindings for child loggers
  const bindings = options.base || {};

  const shouldLog = (logLevel: string): boolean => {
    const levelValue = levelValues[logLevel as LogLevelName] || 30;
    return levelValue >= currentLevel;
  };

  const getConsoleMethod = (logLevel: string): (...args: unknown[]) => void => {
    const consoleObj = getConsole();
    
    if (!consoleObj) {
      return () => {}; // No-op if console doesn't exist
    }

    // Fallback to console.log if specific methods don't exist
    const fallback = consoleObj.log ? consoleObj.log.bind(consoleObj) : () => {};

    switch (logLevel) {
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
  };

  const formatMessage = (logLevel: string, obj: unknown, msg?: string, ...args: unknown[]): void => {
    if (!shouldLog(logLevel)) return;

    const timestamp = new Date().toISOString();
    const levelLabel = logLevel.toUpperCase();
    
    // Create log entry for in-memory storage
    const logEntry: LogEntry = {
      time: Date.now(),
      level: levelValues[logLevel as LogLevelName],
      msg: '',
      ...bindings
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
    inMemoryDestination.write(logEntry);

    // Format for console output
    const prefix = `[${timestamp}] ${levelLabel}:`;
    const hasContext = Object.keys(contextObj).length > 0;
    
    // Choose appropriate console method
    const consoleMethod = getConsoleMethod(logLevel);

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
      if (obj instanceof Error || (logLevel === 'error' || logLevel === 'fatal')) {
        const error = obj instanceof Error ? obj : new Error(messageStr);
        Sentry.captureException(error);
      }
    }
  };

  // Create log methods using a helper function to reduce repetition
  const createLogMethod = (level: string): LogFn => 
    (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => {
      formatMessage(level, obj, msg, ...args);
    };

  const clear = (): void => {
    inMemoryDestination.clear();
    // Check if console.clear exists before calling it
    const consoleObj = getConsole();
    if (consoleObj && consoleObj.clear) {
      consoleObj.clear();
    }
  };

  const child = (childBindings: Record<string, unknown>): Logger => {
    return createBrowserLogger({
      level: level,
      base: { ...bindings, ...childBindings }
    });
  };
  
  // Return object implementing Logger interface with all methods
  return {
    level,
    trace: createLogMethod('trace'),
    debug: createLogMethod('debug'),
    info: createLogMethod('info'),
    warn: createLogMethod('warn'),
    error: createLogMethod('error'),
    fatal: createLogMethod('fatal'),
    success: createLogMethod('success'),
    progress: createLogMethod('progress'),
    log: createLogMethod('log'),
    clear,
    child
  };
}

// ============================================================================
// Configuration
// ============================================================================

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
function extractBindingsConfig(bindings: LoggerBindings | boolean): {
  level: string;
  base: Record<string, unknown>;
  forceType?: 'browser' | 'node';
} {
  let level = effectiveLogLevel;
  let base: Record<string, unknown> = {};
  let forceType: 'browser' | 'node' | undefined;
  
  if (typeof bindings === 'object' && bindings !== null) {
    // Extract __forceType if present
    forceType = bindings.__forceType;
    
    // Check if level is provided in bindings
    if ('level' in bindings) {
      level = bindings.level as string;
    }
    
    // Remove special properties from base bindings
    const { level: _, __forceType: __, ...rest } = bindings;
    base = rest;
  }
  
  return { level, base, forceType };
}

// ============================================================================
// Pino Configuration
// ============================================================================

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

// ============================================================================
// Core Logger Factory
// ============================================================================

// Core logger creation logic shared between sync and async versions
function createLoggerCore(
  bindings: LoggerBindings | boolean,
  pinoLoader: (() => any) | (() => Promise<any>),
  isAsync: boolean = false
): Logger | Promise<Logger> {
  const { level, base, forceType } = extractBindingsConfig(bindings);
  
  // Force browser logger if requested (for testing)
  if (forceType === 'browser') {
    const opts: BrowserLoggerOptions = { level, base };
    return createBrowserLogger(opts);
  }
  
  const { isBrowser, isNode } = getEnvironment();
  
  // Browser environment: use BrowserLogger
  if (isBrowser) {
    const opts: BrowserLoggerOptions = { level, base };
    return createBrowserLogger(opts);
  }
  
  // Node.js environment: use Pino
  if (isNode) {
    const createPinoLogger = (Pino: any) => {
      const opts: PinoOptions = { ...options } as PinoOptions;
      opts.base = base;
      
      // Add transport for async version
      if (isAsync) {
        opts.transport = {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: showTimestamps ? 'SYS:standard' : false,
            ignore: showTimestamps ? 'pid,hostname' : 'pid,hostname,time',
          },
        };
      }
      
      const pinoLogger = Pino(opts) as unknown as ExtendedPinoLogger;
      
      pinoLogger.clear = () => {
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
    };

    // Handle async loading
    if (isAsync) {
      return (pinoLoader as () => Promise<any>)()
        .then(createPinoLogger)
        .catch((error) => {
          const consoleObj = getConsole();
          if (consoleObj && consoleObj.warn) {
            consoleObj.warn('Pino not available, falling back to BrowserLogger:', error);
          }
          const opts: BrowserLoggerOptions = { level, base };
          return createBrowserLogger(opts);
        });
    }
    
    // Handle sync loading
    try {
      const Pino = (pinoLoader as () => any)();
      return createPinoLogger(Pino);
    } catch (error) {
      const consoleObj = getConsole();
      if (consoleObj && consoleObj.warn) {
        consoleObj.warn('Pino not available, falling back to BrowserLogger:', error);
      }
      const opts: BrowserLoggerOptions = { level, base };
      return createBrowserLogger(opts);
    }
  }
  
  // Unknown environment: use BrowserLogger as safe fallback
  const opts: BrowserLoggerOptions = { level, base };
  return createBrowserLogger(opts);
}

// Async logger factory function using dynamic imports (recommended for new code)
const createLoggerAsync = async (bindings: LoggerBindings | boolean = false): Promise<Logger> => {
  return createLoggerCore(bindings, loadPinoAsync, true) as Promise<Logger>;
};

// Synchronous logger factory function (for backward compatibility)
// Uses require() through sync loaders, will be deprecated in future versions
const createLogger = (bindings: LoggerBindings | boolean = false): Logger => {
  return createLoggerCore(bindings, loadPinoSync, false) as Logger;
};

// ============================================================================
// Global Logger Initialization
// ============================================================================

// Initialize logger based on environment
let logger: Logger;

// Get current environment
const currentEnv = getEnvironment();

if (currentEnv.isBrowser) {
  // Browser environment: use BrowserLogger
  logger = createBrowserLogger({
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
    const destination = createInMemoryDestination(stream);
    const pinoLogger = Pino(options, destination) as unknown as ExtendedPinoLogger;
    
    // Store destination reference for clear method
    pinoLogger[PINO_DESTINATION_SYMBOL] = destination;
    
    // Add clear method to logger
    pinoLogger.clear = () => {
      const dest = pinoLogger[PINO_DESTINATION_SYMBOL];
      if (dest && typeof dest.clear === 'function') {
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
    logger = createBrowserLogger({
      level: effectiveLogLevel
    });
  }
} else {
  // Unknown environment: use BrowserLogger as safe fallback
  logger = createBrowserLogger({
    level: effectiveLogLevel
  });
}

// ============================================================================
// Exports
// ============================================================================

// Extend the logger type to include custom methods
export interface ElizaLogger extends Logger {
  success: LogFn;
  progress: LogFn;
  log: LogFn;
}

// Cast logger to include custom methods
const typedLogger = logger as ElizaLogger;

// Main exports
export { createLogger, createLoggerAsync, typedLogger as logger };

// Backward compatibility
export const elizaLogger = typedLogger;

// Testing utilities (only exposed in test environment)
export { envDetector };

// Default export
export default typedLogger;
