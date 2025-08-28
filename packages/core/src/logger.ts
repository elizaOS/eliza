import { Sentry } from './sentry/instrument';
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
          return `${timestamp} ${entry.msg}`.trim();
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

/**
 * Maps ElizaOS log levels to Adze log levels
 */
function mapToAdzeActiveLevel(level: string): string {
  const normalized = level.toLowerCase();
  if (normalized === 'trace') return 'verbose';
  if (normalized === 'fatal') return 'alert';
  return normalized;
}

// Configure Adze globally
const adzeStore = setup({
  activeLevel: mapToAdzeActiveLevel(effectiveLogLevel) as any,
  format: raw ? 'json' : 'pretty',
  timestampFormatter: showTimestamps ? undefined : () => '',
  withEmoji: false,
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

  return chain.meta(metaBase).seal();
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

  // Create sealed Adze instance with configuration
  const sealed = sealAdze(base);
  const currentLevel = (level || effectiveLogLevel).toLowerCase();

  /**
   * Capture errors to Sentry if configured
   */
  const captureIfError = (method: string, args: unknown[]): void => {
    if (getEnvironmentVar('SENTRY_LOGGING') !== 'false') {
      if (method === 'error' || method === 'fatal' || method === 'alert') {
        for (const arg of args) {
          if (arg instanceof Error) {
            Sentry.captureException(arg);
            return;
          }
        }
        // Create error from message if no Error object found
        const message = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
        if (message) {
          Sentry.captureException(new Error(message));
        }
      }
    }
  };

  /**
   * Invoke Adze method with error capture
   */
  const invoke = (method: string, ...args: unknown[]): void => {
    // Ensure Sentry sees the semantic level name (e.g., 'fatal')
    captureIfError(method, args);

    // Map Eliza methods to correct Adze invocations
    let adzeMethod = method;
    let adzeArgs = args;

    // Normalize special cases
    if (method === 'fatal') {
      // Adze uses 'alert' for fatal-level logging
      adzeMethod = 'alert';
    } else if (method === 'progress') {
      // Use Adze custom level for progress
      adzeMethod = 'custom';
      adzeArgs = ['progress', ...args];
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
