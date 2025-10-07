// Expose a tiny test hook to clear env cache in logger tests (kept internal)
// Note: we re-export a function that clears the environment cache indirectly via getEnv
export const __loggerTestHooks = {
  __noop: () => {},
};
import { getEnv as getEnvironmentVar } from './utils/environment';
import adze, { setup } from 'adze';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Log function signature matching Pino's API for compatibility
 */
type LogFn = (
  obj: Record<string, unknown> | string | Error,
  msg?: string,
  ...args: unknown[]
) => void;

/**
 * Logger interface - ElizaOS standard logger API
 */
export interface Logger {
  level: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  success: LogFn;
  progress: LogFn;
  log: LogFn;
  clear: () => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

/**
 * Configuration for logger creation
 */
export interface LoggerBindings extends Record<string, unknown> {
  level?: string;
  namespace?: string;
  namespaces?: string[];
  maxMemoryLogs?: number;
  __forceType?: 'browser' | 'node'; // For testing - forces specific environment behavior
}

/**
 * Log entry structure for in-memory storage
 */
interface LogEntry {
  time: number;
  level?: number;
  msg: string;
}

/**
 * In-memory destination for recent logs
 */
interface InMemoryDestination {
  write: (entry: LogEntry) => void;
  clear: () => void;
  recentLogs: () => string;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Log level priorities for filtering
 */
const LOG_LEVEL_PRIORITY: Record<string, number> = {
  trace: 10,
  verbose: 10,
  debug: 20,
  success: 27,
  progress: 28,
  log: 29,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  alert: 60,
};

/**
 * Reverse mapping from numeric level to preferred level name
 * When multiple level names have the same numeric value, we prioritize the most semantic one
 */
const LEVEL_TO_NAME: Record<number, string> = {
  10: 'trace', // prefer 'trace' over 'verbose'
  20: 'debug',
  27: 'success',
  28: 'progress',
  29: 'log',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal', // prefer 'fatal' over 'alert'
};

/**
 * Check if a message should be logged based on current level
 */
function shouldLog(messageLevel: string, currentLevel: string): boolean {
  const messagePriority = LOG_LEVEL_PRIORITY[messageLevel.toLowerCase()] || 30;
  const currentPriority = LOG_LEVEL_PRIORITY[currentLevel.toLowerCase()] || 30;
  return messagePriority >= currentPriority;
}

/**
 * Safe JSON stringify that handles circular references
 */
function safeStringify(obj: unknown): string {
  try {
    const seen = new WeakSet();
    return JSON.stringify(obj, (_, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
  } catch {
    return String(obj);
  }
}

/**
 * Parse boolean from text string
 */
function parseBooleanFromText(value: string | undefined | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

// ============================================================================
// Configuration
// ============================================================================

// Log level configuration
const DEFAULT_LOG_LEVEL = 'info';
const effectiveLogLevel = getEnvironmentVar('LOG_LEVEL') || DEFAULT_LOG_LEVEL;

// Custom log levels mapping (ElizaOS to Adze)
// Note: These are for our internal shouldLog function, not Adze's levels
export const customLevels: Record<string, number> = {
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

// Configuration flags
const raw = parseBooleanFromText(getEnvironmentVar('LOG_JSON_FORMAT'));
const showTimestamps = parseBooleanFromText(getEnvironmentVar('LOG_TIMESTAMPS') ?? 'true');

// ============================================================================
// In-Memory Log Storage
// ============================================================================

/**
 * Creates an in-memory destination for storing recent logs
 */
function createInMemoryDestination(maxLogs = 100): InMemoryDestination {
  const logs: LogEntry[] = [];

  return {
    write(entry: LogEntry): void {
      logs.push(entry);
      if (logs.length > maxLogs) {
        logs.shift();
      }
    },
    clear(): void {
      logs.length = 0;
    },
    recentLogs(): string {
      return logs
        .map((entry) => {
          const timestamp = showTimestamps ? new Date(entry.time).toISOString() : '';
          // Convert numeric level back to string using the reverse mapping
          const levelStr = LEVEL_TO_NAME[entry.level ?? 30] || 'info';
          return `${timestamp} ${levelStr} ${entry.msg}`.trim();
        })
        .join('\n');
    },
  };
}

// Global in-memory destination
const globalInMemoryDestination = createInMemoryDestination();

// ============================================================================
// Adze Configuration
// ============================================================================

// Configure Adze globally
// Map ElizaOS log levels to Adze log levels
const getAdzeActiveLevel = () => {
  const level = effectiveLogLevel.toLowerCase();
  if (level === 'trace') return 'verbose';
  if (level === 'debug') return 'debug';
  if (level === 'log') return 'log';
  if (level === 'info') return 'info';
  if (level === 'warn') return 'warn';
  if (level === 'error') return 'error';
  if (level === 'fatal') return 'alert';
  return 'info'; // Default to info
};

const adzeActiveLevel = getAdzeActiveLevel();

// Reusable custom level configuration - improved colors and emojis for better terminal readability
const customLevelConfig: Record<string, any> = {
  alert: {
    levelName: 'alert',
    level: 0,
    style: 'font-size: 12px; color: #ff0000;',
    terminalStyle: ['bgRed' as const, 'white' as const, 'bold' as const], // Critical - keep background
    method: 'error' as any,
    emoji: '', // Visual scanning help
  },
  error: {
    levelName: 'error',
    level: 1,
    style: 'font-size: 12px; color: #ff0000;',
    terminalStyle: ['bgRed' as const, 'whiteBright' as const, 'bold' as const], // Loud and bright - white on red
    method: 'error' as any,
    emoji: '',
  },
  warn: {
    levelName: 'warn',
    level: 2,
    style: 'font-size: 12px; color: #ffaa00;',
    terminalStyle: ['bgYellow' as const, 'black' as const, 'bold' as const], // Bright but less than error - black on yellow
    method: 'warn' as any,
    emoji: '',
  },
  info: {
    levelName: 'info',
    level: 3,
    style: 'font-size: 12px; color: #0099ff;',
    terminalStyle: ['cyan' as const], // Minimal - just cyan text, no background
    method: 'info' as any,
    emoji: '',
  },
  fail: {
    levelName: 'fail',
    level: 4,
    style: 'font-size: 12px; color: #ff6600;',
    terminalStyle: ['red' as const, 'underline' as const], // Red underlined text, no background
    method: 'error' as any,
    emoji: '',
  },
  success: {
    levelName: 'success',
    level: 5,
    style: 'font-size: 12px; color: #00cc00;',
    terminalStyle: ['green' as const], // Minimal - just green text
    method: 'log' as any,
    emoji: '',
  },
  log: {
    levelName: 'log',
    level: 6,
    style: 'font-size: 12px; color: #888888;',
    terminalStyle: ['white' as const], // Minimal - just white text
    method: 'log' as any,
    emoji: '',
  },
  debug: {
    levelName: 'debug',
    level: 7,
    style: 'font-size: 12px; color: #9b59b6;',
    terminalStyle: ['gray' as const, 'dim' as const], // Dark and subtle since off by default
    method: 'debug' as any,
    emoji: '',
  },
  verbose: {
    levelName: 'verbose',
    level: 8,
    style: 'font-size: 12px; color: #666666;',
    terminalStyle: ['gray' as const, 'dim' as const, 'italic' as const], // Very subtle
    method: 'debug' as any,
    emoji: '',
  },
};

const adzeStore = setup({
  activeLevel: adzeActiveLevel,
  format: raw ? 'json' : 'pretty',
  timestampFormatter: showTimestamps ? undefined : () => '',
  withEmoji: false,
  levels: customLevelConfig,
});

// Mirror Adze output to in-memory storage
adzeStore.addListener('*', (log: any) => {
  try {
    const d = log.data;
    const msg = Array.isArray(d?.message)
      ? d.message.map((m: unknown) => (typeof m === 'string' ? m : safeStringify(m))).join(' ')
      : typeof d?.message === 'string'
        ? d.message
        : '';

    const entry: LogEntry = {
      time: Date.now(),
      level: typeof d?.level === 'number' ? d.level : undefined,
      msg,
    };
    globalInMemoryDestination.write(entry);
  } catch {
    // Silent fail - don't break logging
  }
});

// ============================================================================
// Logger Factory
// ============================================================================

/**
 * Creates a sealed Adze logger instance with namespaces and metadata
 */
function sealAdze(base: Record<string, unknown>): ReturnType<typeof adze.seal> {
  let chain = adze as any;

  // Add namespaces if provided
  const namespaces: string[] = [];
  if (typeof base.namespace === 'string') namespaces.push(base.namespace);
  if (Array.isArray(base.namespaces)) namespaces.push(...(base.namespaces as string[]));
  if (namespaces.length > 0) {
    chain = chain.ns(...namespaces);
  }

  // Add metadata (excluding namespace properties)
  const metaBase = { ...base };
  delete (metaBase as any).namespace;
  delete (metaBase as any).namespaces;

  // Add required fields for JSON format if not provided
  if (raw) {
    // Only add defaults if user hasn't provided them
    if (!metaBase.name) {
      metaBase.name = 'elizaos';
    }
    if (!metaBase.hostname) {
      // Get hostname in a way that works in both Node and browser
      let hostname = 'unknown';
      if (typeof process !== 'undefined' && process.platform) {
        // Node.js environment
        try {
          const os = require('os');
          hostname = os.hostname();
        } catch {
          // Fallback if os module not available
          hostname = 'localhost';
        }
      } else if (typeof window !== 'undefined' && window.location) {
        // Browser environment
        hostname = window.location.hostname || 'browser';
      }
      metaBase.hostname = hostname;
    }
  }

  // This ensures the sealed logger inherits the correct log level and styling
  const globalConfig = {
    activeLevel: getAdzeActiveLevel(),
    format: raw ? 'json' : 'pretty',
    timestampFormatter: showTimestamps ? undefined : () => '',
    withEmoji: false,
    levels: customLevelConfig, // Use same reusable config
  };

  return chain.meta(metaBase).seal(globalConfig);
}

/**
 * Extract configuration from bindings
 */
function extractBindingsConfig(bindings: LoggerBindings | boolean): {
  level: string;
  base: Record<string, unknown>;
  maxMemoryLogs?: number;
} {
  let level = effectiveLogLevel;
  let base: Record<string, unknown> = {};
  let maxMemoryLogs: number | undefined;

  if (typeof bindings === 'object' && bindings !== null) {
    if ('level' in bindings) {
      level = bindings.level as string;
    }
    if ('maxMemoryLogs' in bindings && typeof bindings.maxMemoryLogs === 'number') {
      maxMemoryLogs = bindings.maxMemoryLogs;
    }

    // Extract base bindings (excluding special properties)
    const { level: _, maxMemoryLogs: __, ...rest } = bindings;
    base = rest;
  }

  return { level, base, maxMemoryLogs };
}

/**
 * Creates a logger instance using Adze
 * @param bindings - Logger configuration or boolean flag
 * @returns Logger instance with ElizaOS API
 */
function createLogger(bindings: LoggerBindings | boolean = false): Logger {
  const { level, base, maxMemoryLogs } = extractBindingsConfig(bindings);

  // Reset memory buffer if custom limit requested
  if (typeof maxMemoryLogs === 'number' && maxMemoryLogs > 0) {
    globalInMemoryDestination.clear();
  }

  // Check if we should force browser behavior (for testing)
  const forceBrowser =
    typeof bindings === 'object' &&
    bindings &&
    '__forceType' in bindings &&
    bindings.__forceType === 'browser';

  // If forcing browser mode, create a simple console-based logger
  if (forceBrowser) {
    const levelStr = typeof level === 'number' ? 'info' : level || effectiveLogLevel;
    const currentLevel = levelStr.toLowerCase();

    const formatArgs = (...args: unknown[]): string => {
      return args
        .map((arg) => {
          if (typeof arg === 'string') return arg;
          if (arg instanceof Error) return arg.message;
          return safeStringify(arg);
        })
        .join(' ');
    };

    const logToConsole = (method: string, ...args: unknown[]): void => {
      if (!shouldLog(method, currentLevel)) {
        return;
      }

      const message = formatArgs(...args);
      const consoleMethod =
        method === 'fatal'
          ? 'error'
          : method === 'trace' || method === 'verbose'
            ? 'debug'
            : method === 'success' || method === 'progress'
              ? 'info'
              : method === 'log'
                ? 'log'
                : (console as any)[method]
                  ? method
                  : 'log';

      if (typeof (console as any)[consoleMethod] === 'function') {
        (console as any)[consoleMethod](message);
      }
    };

    const adaptArgs = (
      obj: Record<string, unknown> | string | Error,
      msg?: string,
      ...args: unknown[]
    ): unknown[] => {
      if (typeof obj === 'string') {
        return msg !== undefined ? [obj, msg, ...args] : [obj, ...args];
      }
      if (obj instanceof Error) {
        return msg !== undefined ? [obj.message, msg, ...args] : [obj.message, ...args];
      }
      if (msg !== undefined) {
        return [msg, obj, ...args];
      }
      return [obj, ...args];
    };

    return {
      level: currentLevel,
      trace: (obj, msg, ...args) => logToConsole('trace', ...adaptArgs(obj, msg, ...args)),
      debug: (obj, msg, ...args) => logToConsole('debug', ...adaptArgs(obj, msg, ...args)),
      info: (obj, msg, ...args) => logToConsole('info', ...adaptArgs(obj, msg, ...args)),
      warn: (obj, msg, ...args) => logToConsole('warn', ...adaptArgs(obj, msg, ...args)),
      error: (obj, msg, ...args) => logToConsole('error', ...adaptArgs(obj, msg, ...args)),
      fatal: (obj, msg, ...args) => logToConsole('fatal', ...adaptArgs(obj, msg, ...args)),
      success: (obj, msg, ...args) => logToConsole('success', ...adaptArgs(obj, msg, ...args)),
      progress: (obj, msg, ...args) => logToConsole('progress', ...adaptArgs(obj, msg, ...args)),
      log: (obj, msg, ...args) => logToConsole('log', ...adaptArgs(obj, msg, ...args)),
      clear: () => {
        if (typeof console.clear === 'function') console.clear();
      },
      child: (childBindings: Record<string, unknown>) =>
        createLogger({ level: currentLevel, ...base, ...childBindings, __forceType: 'browser' }),
    };
  }

  // Create sealed Adze instance with configuration
  const sealed = sealAdze(base);
  const levelStr = typeof level === 'number' ? 'info' : level || effectiveLogLevel;
  const currentLevel = levelStr.toLowerCase();

  // No-op: previously captured to Sentry; removed for browser compatibility
  const captureIfError = (_method: string, _args: unknown[]): void => {};

  /**
   * Invoke Adze method with error capture
   */
  const invoke = (method: string, ...args: unknown[]): void => {
    // Check if this log level should be output
    if (!shouldLog(method, currentLevel)) {
      return;
    }

    // Ensure Sentry sees the semantic level name (e.g., 'fatal')
    captureIfError(method, args);

    // Capture to in-memory destination for API access (even for namespaced loggers)
    try {
      let msg = '';
      if (args.length > 0) {
        msg = args
          .map((arg) => {
            if (typeof arg === 'string') return arg;
            if (arg instanceof Error) return arg.message;
            return safeStringify(arg);
          })
          .join(' ');
      }

      // Include namespace in the message if present
      if (base.namespace) {
        msg = `#${base.namespace}  ${msg}`;
      }

      const entry: LogEntry = {
        time: Date.now(),
        level: LOG_LEVEL_PRIORITY[method.toLowerCase()] || LOG_LEVEL_PRIORITY.info,
        msg,
      };

      globalInMemoryDestination.write(entry);
    } catch {
      // Silent fail - don't break logging
    }

    // Map Eliza methods to correct Adze invocations
    let adzeMethod = method;
    let adzeArgs = args;

    // Normalize special cases - map our custom levels to Adze levels
    if (method === 'fatal') {
      // Adze uses 'alert' for fatal-level logging
      adzeMethod = 'alert';
    } else if (method === 'progress') {
      // Map progress to info level with a prefix
      adzeMethod = 'info';
      adzeArgs = ['[PROGRESS]', ...args];
    } else if (method === 'success') {
      // Map success to info level with a prefix
      adzeMethod = 'info';
      adzeArgs = ['[SUCCESS]', ...args];
    } else if (method === 'trace') {
      // Map trace to verbose
      adzeMethod = 'verbose';
    }

    try {
      (sealed as any)[adzeMethod](...adzeArgs);
    } catch (error) {
      // Fallback to console if Adze fails
      console.log(`[${method.toUpperCase()}]`, ...args);
    }
  };

  /**
   * Adapt ElizaOS logger API arguments to Adze format
   */
  const adaptArgs = (
    obj: Record<string, unknown> | string | Error,
    msg?: string,
    ...args: unknown[]
  ): unknown[] => {
    // String first argument
    if (typeof obj === 'string') {
      return msg !== undefined ? [obj, msg, ...args] : [obj, ...args];
    }
    // Error object
    if (obj instanceof Error) {
      return msg !== undefined
        ? [obj.message, { error: obj }, msg, ...args]
        : [obj.message, { error: obj }, ...args];
    }
    // Object (context) - put message first if provided
    if (msg !== undefined) {
      return [msg, obj, ...args];
    }
    return [obj, ...args];
  };

  // Create log methods
  const trace: LogFn = (obj, msg, ...args) => invoke('verbose', ...adaptArgs(obj, msg, ...args));
  const debug: LogFn = (obj, msg, ...args) => invoke('debug', ...adaptArgs(obj, msg, ...args));
  const info: LogFn = (obj, msg, ...args) => invoke('info', ...adaptArgs(obj, msg, ...args));
  const warn: LogFn = (obj, msg, ...args) => invoke('warn', ...adaptArgs(obj, msg, ...args));
  const error: LogFn = (obj, msg, ...args) => invoke('error', ...adaptArgs(obj, msg, ...args));
  const fatal: LogFn = (obj, msg, ...args) => invoke('fatal', ...adaptArgs(obj, msg, ...args));
  const success: LogFn = (obj, msg, ...args) => invoke('success', ...adaptArgs(obj, msg, ...args));
  const progress: LogFn = (obj, msg, ...args) =>
    invoke('progress', ...adaptArgs(obj, msg, ...args));
  const logFn: LogFn = (obj, msg, ...args) => invoke('log', ...adaptArgs(obj, msg, ...args));

  /**
   * Clear console and memory buffer
   */
  const clear = (): void => {
    try {
      if (typeof console?.clear === 'function') {
        console.clear();
      }
    } catch {
      // Silent fail
    }
    globalInMemoryDestination.clear();
  };

  /**
   * Create child logger with additional bindings
   */
  const child = (childBindings: Record<string, unknown>): Logger => {
    return createLogger({ level: currentLevel, ...base, ...childBindings });
  };

  return {
    level: currentLevel,
    trace,
    debug,
    info,
    warn,
    error,
    fatal,
    success,
    progress,
    log: logFn,
    clear,
    child,
  };
}

// ============================================================================
// Exports
// ============================================================================

// Create default logger instance
const logger = createLogger();

// Backward compatibility alias
export const elizaLogger = logger;

// Export recent logs function
export const recentLogs = (): string => globalInMemoryDestination.recentLogs();

// Export everything
export { logger, createLogger };
export default logger;
