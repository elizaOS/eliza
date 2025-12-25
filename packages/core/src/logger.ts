// Expose a tiny test hook to clear env cache in logger tests (kept internal)
// Note: we re-export a function that clears the environment cache indirectly via getEnv
export const __loggerTestHooks = {
  __noop: () => {},
};
import { getEnv as getEnvironmentVar } from './utils/environment';
import adze, { setup } from 'adze';
import fastRedact from 'fast-redact';

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
  const seen = new WeakSet();
  return JSON.stringify(obj, (_, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
}

/**
 * Parse boolean from text string
 */
function parseBooleanFromText(value: string | undefined | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

/**
 * Format a value for display in pretty log extras
 */
function formatExtraValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return value.message;
  return safeStringify(value);
}

/**
 * Format a log entry in compact pretty format
 * Format: [src] message (key=val, key=val)
 *
 * Note: agentId/agentName are NOT displayed in pretty mode because:
 * - Loggers with namespace already show #agentName prefix (via Adze)
 * - These fields ARE still included in JSON mode for filtering/monitoring
 */
function formatPrettyLog(
  context: Record<string, unknown>,
  message: string,
  isJsonMode: boolean
): string {
  // In JSON mode, don't format - return message as-is
  if (isJsonMode) {
    return message;
  }

  const src = context.src as string | undefined;

  // Build prefix: [SRC] in uppercase
  const srcPart = src ? `[${src.toUpperCase()}] ` : '';

  // Build extras: (key=val, key=val)
  // Exclude: src (already in prefix), agentId/agentName (shown via Adze namespace #agent)
  const excludeKeys = ['src', 'agentId', 'agentName'];
  const extraPairs: string[] = [];

  for (const [key, value] of Object.entries(context)) {
    if (excludeKeys.includes(key)) continue;
    if (value === undefined) continue;
    extraPairs.push(`${key}=${formatExtraValue(value)}`);
  }

  const extrasPart = extraPairs.length > 0 ? ` (${extraPairs.join(', ')})` : '';

  return `${srcPart}${message}${extrasPart}`;
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

// Generate a unique server ID for this process instance
const serverId =
  getEnvironmentVar('SERVER_ID') ||
  (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10));

// Configure sensitive data redaction
// Paths use wildcards to match nested objects: *.password matches { user: { password: 'x' } }
const redact = fastRedact({
  paths: [
    'password',
    'passwd',
    'secret',
    'token',
    'apiKey',
    'api_key',
    'apiSecret',
    'api_secret',
    'authorization',
    'auth',
    'credential',
    'credentials',
    'privateKey',
    'private_key',
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'cookie',
    'session',
    'jwt',
    'bearer',
    // Wildcard paths for nested objects
    '*.password',
    '*.secret',
    '*.token',
    '*.apiKey',
    '*.api_key',
    '*.authorization',
    '*.credential',
    '*.credentials',
    '*.privateKey',
    '*.accessToken',
    '*.refreshToken',
  ],
  serialize: false, // Don't stringify, just redact in place
  censor: '[REDACTED]',
});

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

// Adze terminal style values - matches what the library accepts
type AdzeTerminalStyle =
  | 'bgRed' | 'white' | 'bold' | 'whiteBright' | 'bgYellow' | 'black'
  | 'cyan' | 'red' | 'underline' | 'green' | 'gray' | 'dim' | 'italic'
  | 'yellow' | 'blue' | 'magenta' | 'blackBright' | 'strikethrough';

// Adze console methods - subset that the library accepts
type AdzeConsoleMethod =
  | 'error' | 'debug' | 'log' | 'info' | 'warn' | 'clear'
  | 'dir' | 'dirxml' | 'group' | 'groupCollapsed' | 'groupEnd' | 'table';

// Adze level configuration as expected by setup()
interface AdzeLevelConfig {
  levelName: string;
  level: number;
  style: string;
  terminalStyle: AdzeTerminalStyle[];
  method: AdzeConsoleMethod;
  emoji: string;
}

const customLevelConfig: Record<string, AdzeLevelConfig> = {
  alert: {
    levelName: 'alert',
    level: 0,
    style: 'font-size: 12px; color: #ff0000;',
    terminalStyle: ['bgRed', 'white', 'bold'], // Critical - keep background
    method: 'error',
    emoji: '', // Visual scanning help
  },
  error: {
    levelName: 'error',
    level: 1,
    style: 'font-size: 12px; color: #ff0000;',
    terminalStyle: ['bgRed', 'whiteBright', 'bold'], // Loud and bright - white on red
    method: 'error',
    emoji: '',
  },
  warn: {
    levelName: 'warn',
    level: 2,
    style: 'font-size: 12px; color: #ffaa00;',
    terminalStyle: ['bgYellow', 'black', 'bold'], // Bright but less than error - black on yellow
    method: 'warn',
    emoji: '',
  },
  info: {
    levelName: 'info',
    level: 3,
    style: 'font-size: 12px; color: #0099ff;',
    terminalStyle: ['cyan'], // Minimal - just cyan text, no background
    method: 'info',
    emoji: '',
  },
  fail: {
    levelName: 'fail',
    level: 4,
    style: 'font-size: 12px; color: #ff6600;',
    terminalStyle: ['red', 'underline'], // Red underlined text, no background
    method: 'error',
    emoji: '',
  },
  success: {
    levelName: 'success',
    level: 5,
    style: 'font-size: 12px; color: #00cc00;',
    terminalStyle: ['green'], // Minimal - just green text
    method: 'log',
    emoji: '',
  },
  log: {
    levelName: 'log',
    level: 6,
    style: 'font-size: 12px; color: #888888;',
    terminalStyle: ['white'], // Minimal - just white text
    method: 'log',
    emoji: '',
  },
  debug: {
    levelName: 'debug',
    level: 7,
    style: 'font-size: 12px; color: #9b59b6;',
    terminalStyle: ['gray', 'dim'], // Dark and subtle since off by default
    method: 'debug',
    emoji: '',
  },
  verbose: {
    levelName: 'verbose',
    level: 8,
    style: 'font-size: 12px; color: #666666;',
    terminalStyle: ['gray', 'dim', 'italic'], // Very subtle
    method: 'debug',
    emoji: '',
  },
};

// Adze's setup function has a specific type expectation for levels.
// Our AdzeLevelConfig already matches the structure Adze expects.
const adzeStore = setup({
  activeLevel: adzeActiveLevel,
  format: raw ? 'json' : 'pretty',
  timestampFormatter: showTimestamps ? undefined : () => '',
  withEmoji: false,
  levels: customLevelConfig as Record<string, AdzeLevelConfig>,
});

// Mirror Adze output to in-memory storage
adzeStore.addListener('*', (log: { data?: { message?: string | unknown[]; level?: number } }) => {
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
});

// ============================================================================
// Logger Factory
// ============================================================================

/**
 * Creates a sealed Adze logger instance with namespaces and metadata
 */
function sealAdze(base: Record<string, unknown>): ReturnType<typeof adze.seal> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chain: ReturnType<typeof adze.ns> | typeof adze = adze as ReturnType<typeof adze.ns> | typeof adze;

  // Add namespaces if provided
  const namespaces: string[] = [];
  if (typeof base.namespace === 'string') namespaces.push(base.namespace);
  if (Array.isArray(base.namespaces)) namespaces.push(...(base.namespaces as string[]));
  if (namespaces.length > 0) {
    chain = chain.ns(...namespaces);
  }

  // Add metadata (excluding namespace properties)
  const metaBase: Record<string, unknown> = { ...base };
  delete metaBase.namespace;
  delete metaBase.namespaces;

  // Add server context metadata (always, for observability)
  // Only add defaults if user hasn't provided them
  if (!metaBase.name) {
    metaBase.name = 'elizaos';
  }

  // Add pid for process identification
  if (!metaBase.pid && typeof process !== 'undefined' && process.pid) {
    metaBase.pid = process.pid;
  }

  // Add environment (production, development, test)
  if (!metaBase.environment && typeof process !== 'undefined' && process.env) {
    metaBase.environment = process.env.NODE_ENV || 'development';
  }

  // Add serverId for instance identification
  if (!metaBase.serverId) {
    metaBase.serverId = serverId;
  }

    // Add hostname (for JSON format or when explicitly needed)
    if (raw && !metaBase.hostname) {
      // Get hostname in a way that works in both Node and browser
      let hostname = 'unknown';
      if (typeof process !== 'undefined' && process.platform) {
        // Node.js environment
        const os = require('os');
        hostname = os.hostname();
      } else if (typeof window !== 'undefined' && window.location) {
        // Browser environment
        hostname = window.location.hostname || 'browser';
      }
      metaBase.hostname = hostname;
    }

  // This ensures the sealed logger inherits the correct log level and styling
  // The type cast to unknown is necessary because Adze's seal() method has overly strict
  // parameter types that don't match its actual runtime expectations.
  const globalConfig = {
    activeLevel: getAdzeActiveLevel(),
    format: raw ? 'json' : 'pretty',
    timestampFormatter: showTimestamps ? undefined : () => '',
    withEmoji: false,
    levels: customLevelConfig as Record<string, AdzeLevelConfig>,
  };

  type SealParams = Parameters<ReturnType<typeof chain.meta>['seal']>[0];
  return chain.meta(metaBase).seal(globalConfig as unknown as SealParams);
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
      const consoleMethod: keyof Console =
        method === 'fatal'
          ? 'error'
          : method === 'trace' || method === 'verbose'
            ? 'debug'
            : method === 'success' || method === 'progress'
              ? 'info'
              : method === 'log'
                ? 'log'
                : method in console && typeof console[method as keyof Console] === 'function'
                  ? (method as keyof Console)
                  : 'log';

      const consoleFn = console[consoleMethod];
      if (consoleFn && typeof consoleFn === 'function') {
        // TypeScript doesn't know that consoleMethod excludes non-function properties
        // but we've already checked typeof consoleFn === 'function', so it's safe
        (consoleFn as (...args: unknown[]) => void)(message);
      }
    };

    /**
     * Safely redact sensitive data from an object (browser version)
     */
    const safeRedact = (obj: Record<string, unknown>): Record<string, unknown> => {
      const copy = { ...obj };
      redact(copy);
      return copy;
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
      // Redact sensitive data from objects
      const redactedObj = safeRedact(obj);
      if (msg !== undefined) {
        // Browser is always pretty mode - format as compact single line
        const formatted = formatPrettyLog(redactedObj, msg, false);
        return [formatted, ...args];
      }
      // No message - format context only
      const formatted = formatPrettyLog(redactedObj, '', false);
      return formatted ? [formatted, ...args] : [...args];
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

    // Adze sealed loggers have dynamically generated methods based on configured log levels.
    // The TypeScript types don't expose these methods, so we use a record type to call them.
    type AdzeLogMethod = (...args: unknown[]) => void;
    const sealedRecord = sealed as unknown as Record<string, AdzeLogMethod>;
    if (adzeMethod in sealedRecord && typeof sealedRecord[adzeMethod] === 'function') {
      sealedRecord[adzeMethod](...adzeArgs);
    }
  };

  /**
   * Safely redact sensitive data from an object
   * Creates a shallow copy to avoid mutating the original
   */
  const safeRedact = (obj: Record<string, unknown>): Record<string, unknown> => {
    // Create a shallow copy to avoid mutating original
    const copy = { ...obj };
    // fast-redact returns the redacted string when serialize:false
    // but mutates the object in place, so we use the copy
    redact(copy);
    return copy;
  };

  /**
   * Adapt ElizaOS logger API arguments to Adze format
   * Also applies redaction to sensitive data in objects
   *
   * In pretty mode: formats as compact single line [src] agent — message (extras)
   * In JSON mode: keeps structured object for machine parsing
   */
  const adaptArgs = (
    obj: Record<string, unknown> | string | Error,
    msg?: string,
    ...args: unknown[]
  ): unknown[] => {
    // String first argument - no context object
    if (typeof obj === 'string') {
      return msg !== undefined ? [obj, msg, ...args] : [obj, ...args];
    }
    // Error object
    if (obj instanceof Error) {
      return msg !== undefined
        ? [obj.message, { error: obj }, msg, ...args]
        : [obj.message, { error: obj }, ...args];
    }

    // Object (context) - redact sensitive data
    const redactedObj = safeRedact(obj);

    if (msg !== undefined) {
      // Pretty mode: format as compact single line
      if (!raw) {
        const formatted = formatPrettyLog(redactedObj, msg, raw);
        return [formatted, ...args];
      }
      // JSON mode: keep structured object for machine parsing
      return [msg, redactedObj, ...args];
    }

    // No message provided - just context object
    if (!raw) {
      // Pretty mode: format the object as a simple string
      const formatted = formatPrettyLog(redactedObj, '', raw);
      return formatted ? [formatted, ...args] : [...args];
    }
    return [redactedObj, ...args];
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
    if (typeof console?.clear === 'function') {
      console.clear();
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
