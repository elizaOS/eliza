import pino, { type LogFn, type DestinationStream } from 'pino';

/**
 * Parses a boolean value from text input.
 *
 * @param {string | undefined | null} value - The text input to be parsed.
 * @returns {boolean} - The boolean value parsed from the text input.
 */
function parseBooleanFromText(value: string | undefined | null): boolean {
  if (!value) return false;

  const affirmative = ['YES', 'Y', 'TRUE', 'T', '1', 'ON', 'ENABLE'];
  const negative = ['NO', 'N', 'FALSE', 'F', '0', 'OFF', 'DISABLE'];

  const normalizedText = value.trim().toUpperCase();

  if (affirmative.includes(normalizedText)) {
    return true;
  }
  if (negative.includes(normalizedText)) {
    return false;
  }

  // For environment variables, we'll treat unrecognized values as false
  return false;
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

// Create a function to generate the pretty configuration
const createPrettyConfig = () => ({
  colorize: true,
  translateTime: 'yyyy-mm-dd HH:MM:ss',
  ignore: 'pid,hostname',
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

const createStream = async () => {
  if (raw) {
    return undefined;
  }
  // dynamically import pretty to avoid importing it in the browser
  const pretty = await import('pino-pretty');
  return pretty.default(createPrettyConfig());
};

// Create options with appropriate level
const options = {
  level: effectiveLogLevel, // Use more restrictive level unless in debug mode
  customLevels,
  hooks: {
    logMethod(inputArgs: [string | Record<string, unknown>, ...unknown[]], method: LogFn): void {
      const [arg1, ...rest] = inputArgs;

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

// Create basic logger initially
let logger = pino(options);

// Add type for logger with clear method
interface LoggerWithClear extends pino.Logger {
  clear: () => void;
}

// Enhance logger with custom destination in Node.js environment
if (typeof process !== 'undefined') {
  // Create the destination with in-memory logging
  // Instead of async initialization, initialize synchronously to avoid race conditions
  let stream = null;

  if (!raw) {
    // If we're in a Node.js environment where require is available, use require for pino-pretty
    // This will ensure synchronous loading
    try {
      const pretty = require('pino-pretty');
      stream = pretty.default ? pretty.default(createPrettyConfig()) : null;
    } catch (e) {
      // Fall back to async loading if synchronous loading fails
      createStream().then((prettyStream) => {
        const destination = new InMemoryDestination(prettyStream);
        logger = pino(options, destination);
        (logger as unknown)[Symbol.for('pino-destination')] = destination;

        // Add clear method to logger
        (logger as unknown as LoggerWithClear).clear = () => {
          const destination = (logger as unknown)[Symbol.for('pino-destination')];
          if (destination instanceof InMemoryDestination) {
            destination.clear();
          }
        };
      });
    }
  }

  // If stream was created synchronously, use it now
  if (stream !== null || raw) {
    const destination = new InMemoryDestination(stream);
    logger = pino(options, destination);
    (logger as unknown)[Symbol.for('pino-destination')] = destination;

    // Add clear method to logger
    (logger as unknown as LoggerWithClear).clear = () => {
      const destination = (logger as unknown)[Symbol.for('pino-destination')];
      if (destination instanceof InMemoryDestination) {
        destination.clear();
      }
    };
  }
}

export { logger };

// for backward compatibility
export const elizaLogger = logger;

export default logger;
