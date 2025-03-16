import pino, { type LogFn, type DestinationStream } from 'pino';

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
    const logEntry: LogEntry = typeof data === 'string' ? JSON.parse(data) : data;

    // Add timestamp if not present
    if (!logEntry.time) {
      logEntry.time = Date.now();
    }

    // Add to memory buffer
    this.logs.push(logEntry);

    // Maintain buffer size
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Forward to pretty print stream if available
    if (this.stream) {
      // Ensure we pass a string to the stream
      const stringData = typeof data === 'string' ? data : JSON.stringify(data);
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

const createStream = async () => {
  if (raw) {
    return undefined;
  }
  // dynamically import pretty to avoid importing it in the browser
  const pretty = await import('pino-pretty');
  return pretty.default({
    colorize: true,
    translateTime: 'yyyy-mm-dd HH:MM:ss',
    ignore: 'pid,hostname',
  });
};

const defaultLevel = process?.env?.DEFAULT_LOG_LEVEL || process?.env?.LOG_LEVEL || 'info';

/**
 * Configuration options for logger.
 * @typedef {object} LoggerOptions
 * @property {string} level - The default log level.
 * @property {object} customLevels - Custom log levels.
 * @property {object} hooks - Hooks for customizing log behavior.
 * @property {Function} hooks.logMethod - Custom log method.
 * @param {Array} inputArgs - The arguments passed to the log method.
 * @param {Function} method - The log method to be executed.
 * @returns {void}
 */
const options = {
  level: defaultLevel,
  customLevels,
  hooks: {
    logMethod(inputArgs: [string | Record<string, unknown>, ...unknown[]], method: LogFn): void {
      const [arg1, ...rest] = inputArgs;

      if (typeof arg1 === 'object') {
        const messageParts = rest.map((arg) =>
          typeof arg === 'string' ? arg : JSON.stringify(arg)
        );
        const message = messageParts.join(' ');
        method.apply(this, [arg1, message]);
      } else {
        const context = {};
        const messageParts = [arg1, ...rest].map((arg) => (typeof arg === 'string' ? arg : arg));
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

// Enhance logger with custom destination in Node.js environment
if (typeof process !== 'undefined') {
  // Create the destination with in-memory logging
  createStream().then((stream) => {
    const destination = new InMemoryDestination(stream);

    // Create enhanced logger with custom destination
    logger = pino(options, destination);

    // Expose the destination for accessing recent logs
    (logger as unknown)[Symbol.for('pino-destination')] = destination;
  });
}

export { logger };

// for backward compatibility
export const elizaLogger = logger;

export default logger;
