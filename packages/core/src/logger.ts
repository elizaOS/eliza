import { Sentry } from './sentry/instrument';
// Type-only imports - stripped at build time, safe for browser
import type { LoggerOptions as PinoLoggerOptions } from 'pino';
import type { PrettyOptions as BasePrettyOptions } from 'pino-pretty';

// ============================================================================
// Environment Detection
// ============================================================================

/**
 * Cached environment detection using simple function-based caching
 * This approach provides better functional alignment while maintaining performance
 */
let cachedEnvironment: { isBrowser: boolean; isNode: boolean } | null = null;

/**
 * Detects the current runtime environment (browser vs Node.js)
 * Results are cached for performance
 */
function getEnvironment(): { isBrowser: boolean; isNode: boolean } {
  // Return cached result if available (for performance)
  if (cachedEnvironment !== null) {
    return cachedEnvironment;
  }

  const isBrowser =
    typeof globalThis !== 'undefined' &&
    typeof globalThis.window !== 'undefined' &&
    typeof globalThis.document !== 'undefined';

  const isNode =
    typeof process !== 'undefined' &&
    typeof process.versions !== 'undefined' &&
    typeof process.versions.node !== 'undefined';

  cachedEnvironment = { isBrowser, isNode };
  return cachedEnvironment;
}

/**
 * Clears the cached environment detection result
 * Useful for testing or when environment changes
 */
function clearEnvironmentCache(): void {
  cachedEnvironment = null;
}

/**
 * Checks if running in Node.js environment
 */
function isNodeEnv(): boolean {
  return getEnvironment().isNode;
}

/**
 * Checks if running in browser environment
 */
function isBrowserEnv(): boolean {
  return getEnvironment().isBrowser;
}

/**
 * Checks if process object is available
 */
function hasProcess(): boolean {
  return typeof process !== 'undefined';
}

/**
 * Gets an environment variable value if process.env is available
 */
function getProcessEnv(key: string): string | undefined {
  if (hasProcess() && process.env) {
    return process.env[key];
  }
  return undefined;
}

// Create a namespace-like object for convenience and backward compatibility
// This preserves the existing API while using the simpler cached functions
const envDetector = {
  getEnvironment,
  clearCache: clearEnvironmentCache,
  isNode: isNodeEnv,
  isBrowser: isBrowserEnv,
  hasProcess,
  getProcessEnv,
};

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
// This module uses synchronous loading for compatibility with existing code.
// The require() usage is documented as technical debt for future ES module migration.
//
// Type Safety Note: We use `import type` from pino/pino-pretty for type definitions.
// These are compile-time only and get stripped during build, making them safe for browser
// environments where pino is not available.

// ============================================================================
// Type Definitions
// ============================================================================

// Type for the dynamically loaded Pino module
type PinoModule = typeof import('pino');

// Type for the dynamically loaded Pino-Pretty module
type PinoPrettyModule = typeof import('pino-pretty');

interface ModuleCache {
  pino?: PinoModule;
  pinoPretty?: PinoPrettyModule;
}

const moduleCache: ModuleCache = {};

// ============================================================================
// Module Loaders
// ============================================================================
/**
 * Load Pino module synchronously using require()
 *
 * TECHNICAL DEBT: This function uses require() instead of ES module imports
 * to provide backward compatibility and runtime conditional loading.
 * Future migration path:
 * 1. Convert to dynamic import() when full ES module support is available
 * 2. Ensure all environments support top-level await
 * 3. Update build toolchain to handle async module loading
 *
 * @returns The loaded Pino module
 * @throws Error if Pino cannot be loaded
 */
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

/**
 * Load Pino-Pretty module synchronously using require()
 *
 * TECHNICAL DEBT: Uses require() for same reasons as loadPinoSync()
 * See loadPinoSync() documentation for migration path details.
 *
 * @returns The loaded Pino-Pretty module or null if not available
 */
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
type LogFn = (
  obj: Record<string, unknown> | string | Error,
  msg?: string,
  ...args: unknown[]
) => void;

// Type for logger bindings with optional test override
export interface LoggerBindings extends Record<string, unknown> {
  __forceType?: 'browser' | 'node';
  level?: string;
  maxMemoryLogs?: number; // Maximum number of logs to keep in memory
}

interface DestinationStream {
  write(data: string | LogEntry): void;
  recentLogs?(): LogEntry[];
  clear?(): void;
}

export interface Logger {
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

// Custom Pino options extending the base type
interface PinoOptions extends Partial<PinoLoggerOptions> {
  customLevels?: Record<string, number>;
  hooks?: {
    logMethod: (inputArgs: [string | Record<string, unknown>, ...unknown[]], method: LogFn) => void;
  };
}

// Extended PrettyOptions with our custom properties
interface ExtendedPrettyOptions extends Partial<BasePrettyOptions> {
  colorize?: boolean;
  translateTime?: string | boolean;
  ignore?: string;
  messageFormat?: string;
  // Custom level colors mapping
  levelColors?: Record<string | number, string>;
  // Custom prettifiers for different log properties
  customPrettifiers?: {
    level?: (inputData: unknown) => string;
    msg?: (msg: string) => string;
    [key: string]: ((value: unknown) => string) | undefined;
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
export interface LogEntry {
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

// Default maximum number of logs to keep in memory
const DEFAULT_MAX_MEMORY_LOGS = 1000;

// Get max logs from environment or use default
const getMaxMemoryLogs = (): number => {
  if (envDetector.hasProcess()) {
    const envValue = envDetector.getProcessEnv('LOG_MAX_MEMORY_SIZE');
    if (envValue) {
      const parsed = parseInt(envValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return DEFAULT_MAX_MEMORY_LOGS;
};

/**
 * Factory function for creating an in-memory destination stream for logging.
 * Returns object implementing DestinationStream interface.
 * @param stream - Optional stream to forward logs to
 * @param maxLogs - Maximum number of logs to keep in memory (default: 1000 or LOG_MAX_MEMORY_SIZE env var)
 */
function createInMemoryDestination(
  stream: DestinationStream | null,
  maxLogs?: number
): DestinationStream {
  let logs: LogEntry[] = [];
  const maxLogsLimit = maxLogs ?? getMaxMemoryLogs();

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
        if (stream) {
          stream.write(data);
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
    const isDebugMode =
      envDetector.hasProcess() &&
      (envDetector.getProcessEnv('LOG_LEVEL') || '').toLowerCase() === 'debug';
    const isLoggingDiagnostic =
      envDetector.hasProcess() && Boolean(envDetector.getProcessEnv('LOG_DIAGNOSTIC'));

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
    if (logs.length > maxLogsLimit) {
      logs.shift();
    }

    // Forward to pretty print stream if available
    if (stream) {
      stream.write(stringData);
    }
  };

  const recentLogs = (): LogEntry[] => logs;
  const clear = (): void => {
    logs = [];
  };

  // Return object implementing DestinationStream interface
  return {
    write,
    recentLogs,
    clear,
  };
}

// ============================================================================
// Browser Logger Implementation
// ============================================================================

/**
 * Factory function to create browser-compatible logger that mimics Pino's API but uses console.log
 */
// Define log level type and values
type LogLevelName =
  | 'fatal'
  | 'error'
  | 'warn'
  | 'info'
  | 'log'
  | 'progress'
  | 'success'
  | 'debug'
  | 'trace';

interface BrowserLoggerOptions {
  level?: LogLevelName | string;
  base?: Record<string, unknown>;
  maxMemoryLogs?: number;
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
  const inMemoryDestination = createInMemoryDestination(null, options.maxMemoryLogs);

  // Set log level
  const level = options.level || 'info';
  const currentLevel = levelValues[level as LogLevelName] || 30;

  // Store bindings for child loggers
  const bindings = options.base || {};

  const shouldLog = (logLevel: string): boolean => {
    const levelValue = levelValues[logLevel as LogLevelName] || 30;
    return levelValue >= currentLevel;
  };

  const getConsoleMethod = (logLevel: string): ((...args: unknown[]) => void) => {
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

  const formatMessage = (
    logLevel: string,
    obj: unknown,
    msg?: string,
    ...args: unknown[]
  ): void => {
    if (!shouldLog(logLevel)) return;

    const timestamp = new Date().toISOString();
    const levelLabel = logLevel.toUpperCase();

    // Create log entry for in-memory storage
    const logEntry: LogEntry = {
      time: Date.now(),
      level: levelValues[logLevel as LogLevelName],
      msg: '',
      ...bindings,
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
        messageStr +=
          ' ' + args.map((a) => (typeof a === 'object' ? safeStringify(a) : String(a))).join(' ');
      }
    } else if (obj instanceof Error) {
      contextObj = { error: { message: obj.message, stack: obj.stack } };
      messageStr = msg || obj.message;
    } else if (typeof obj === 'object' && obj !== null) {
      contextObj = obj as Record<string, unknown>;
      messageStr = msg || '';
      if (args.length > 0) {
        messageStr +=
          ' ' + args.map((a) => (typeof a === 'object' ? safeStringify(a) : String(a))).join(' ');
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
      if (obj instanceof Error || logLevel === 'error' || logLevel === 'fatal') {
        const error = obj instanceof Error ? obj : new Error(messageStr);
        Sentry.captureException(error);
      }
    }
  };

  // Create log methods using a helper function to reduce repetition
  const createLogMethod =
    (level: string): LogFn =>
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
      base: { ...bindings, ...childBindings },
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
    child,
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
const effectiveLogLevel = isDebugMode
  ? 'debug'
  : (envDetector.hasProcess() ? envDetector.getProcessEnv('DEFAULT_LOG_LEVEL') : null) || 'info';

// Check if user wants timestamps in logs (default: true)
const showTimestamps =
  envDetector.hasProcess() && envDetector.getProcessEnv('LOG_TIMESTAMPS') !== undefined
    ? parseBooleanFromText(envDetector.getProcessEnv('LOG_TIMESTAMPS'))
    : true;

// Utility function to extract level and base from bindings
function extractBindingsConfig(bindings: LoggerBindings | boolean): {
  level: string;
  base: Record<string, unknown>;
  forceType?: 'browser' | 'node';
  maxMemoryLogs?: number;
} {
  let level = effectiveLogLevel;
  let base: Record<string, unknown> = {};
  let forceType: 'browser' | 'node' | undefined;
  let maxMemoryLogs: number | undefined;

  if (typeof bindings === 'object' && bindings !== null) {
    // Extract __forceType if present
    forceType = bindings.__forceType;

    // Check if level is provided in bindings
    if ('level' in bindings) {
      level = bindings.level as string;
    }

    // Extract maxMemoryLogs if present
    if ('maxMemoryLogs' in bindings && typeof bindings.maxMemoryLogs === 'number') {
      maxMemoryLogs = bindings.maxMemoryLogs;
    }

    // Remove special properties from base bindings
    const { level: _, __forceType: __, maxMemoryLogs: ___, ...rest } = bindings;
    base = rest;
  }

  return { level, base, forceType, maxMemoryLogs };
}

// ============================================================================
// Pino Configuration
// ============================================================================

// Create a function to generate the pretty configuration
const createPrettyConfig = (): ExtendedPrettyOptions => ({
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
    logMethod: function (
      inputArgs: [string | Record<string, unknown>, ...unknown[]],
      method: LogFn
    ): void {
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
          method.call(this, {
            error: formatError(arg1),
          });
        } else {
          const messageParts = rest.map((arg) =>
            typeof arg === 'string' ? arg : safeStringify(arg)
          );
          const message = messageParts.join(' ');
          method.call(this, arg1, message);
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

        method.call(this, context, message);
      }
    },
  },
};

// ============================================================================
// Core Logger Factory
// ============================================================================

// Synchronous logger factory function
function createLogger(bindings: LoggerBindings | boolean = false): Logger {
  const { level, base, forceType, maxMemoryLogs } = extractBindingsConfig(bindings);

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
    try {
      const Pino = loadPinoSync();
      const opts: PinoOptions = { ...options } as PinoOptions;
      opts.base = base;

      // Create in-memory destination with optional pretty printing
      let stream = null;
      if (!raw) {
        const pretty = loadPinoPrettySync();
        if (pretty) {
          stream = pretty(createPrettyConfig());
        }
      }

      const destination = createInMemoryDestination(stream, maxMemoryLogs);
      const pinoLogger = Pino(opts, destination) as unknown as ExtendedPinoLogger;

      // Store destination reference for clear method
      pinoLogger[PINO_DESTINATION_SYMBOL] = destination;

      pinoLogger.clear = () => {
        const dest = pinoLogger[PINO_DESTINATION_SYMBOL];
        if (dest && typeof dest.clear === 'function') {
          dest.clear();
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

// ============================================================================
// Global Logger Initialization
// ============================================================================

// Initialize the global logger instance using the factory function
const logger: Logger = createLogger(false);

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
export { createLogger, typedLogger as logger };

// Backward compatibility
export const elizaLogger = typedLogger;

// Testing utilities (only exposed in test environment)
export { envDetector };

// Default export
export default typedLogger;
