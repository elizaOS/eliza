/**
 * Logger
 * 
 * Provides a consistent logging interface across the application.
 * Supports multiple log levels, formatting, and output destinations.
 */

import { ErrorLevel } from '../errors/types.js';

/**
 * Log levels
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  /**
   * Minimum log level to display
   */
  level: LogLevel;
  
  /**
   * Whether to include timestamps in logs
   */
  timestamps: boolean;
  
  /**
   * Whether to colorize output
   */
  colors: boolean;
  
  /**
   * Whether to include additional context in logs
   */
  verbose: boolean;
  
  /**
   * Custom output destination (defaults to console)
   */
  destination?: (message: string, level: LogLevel) => void;
}

/**
 * Default logger configuration
 */
const DEFAULT_CONFIG: LoggerConfig = {
  level: LogLevel.INFO,
  timestamps: true,
  colors: true,
  verbose: false
};

/**
 * Logger class
 */
class Logger {
  private config: LoggerConfig;
  
  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * Set logger configuration
   */
  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }
  
  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }
  
  /**
   * Log a debug message
   */
  debug(message: string, context?: any): void {
    this.log(message, LogLevel.DEBUG, context);
  }
  
  /**
   * Log an info message
   */
  info(message: string, context?: any): void {
    this.log(message, LogLevel.INFO, context);
  }
  
  /**
   * Log a warning message
   */
  warn(message: string, context?: any): void {
    this.log(message, LogLevel.WARN, context);
  }
  
  /**
   * Log an error message
   */
  error(message: string, context?: any): void {
    this.log(message, LogLevel.ERROR, context);
  }
  
  /**
   * Log a message with level
   */
  private log(message: string, level: LogLevel, context?: any): void {
    // Check if this log level should be displayed
    if (level < this.config.level) {
      return;
    }
    
    // Format the message
    const formattedMessage = this.formatMessage(message, level, context);
    
    // Send to destination
    if (this.config.destination) {
      this.config.destination(formattedMessage, level);
    } else {
      this.logToConsole(formattedMessage, level);
    }
  }
  
  /**
   * Format a log message
   */
  private formatMessage(message: string, level: LogLevel, context?: any): string {
    let result = '';
    
    // Add timestamp if enabled
    if (this.config.timestamps) {
      const timestamp = new Date().toISOString();
      result += `[${timestamp}] `;
    }
    
    // Add log level
    result += `${this.getLevelName(level)}: `;
    
    // Add message
    result += message;
    
    // Add context if verbose and context is provided
    if (this.config.verbose && context) {
      try {
        if (typeof context === 'object') {
          const contextStr = JSON.stringify(context);
          result += ` ${contextStr}`;
        } else {
          result += ` ${context}`;
        }
      } catch (error) {
        result += ' [Context serialization failed]';
      }
    }
    
    return result;
  }
  
  /**
   * Get the name of a log level
   */
  private getLevelName(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG:
        return this.colorize('DEBUG', '\x1b[36m'); // Cyan
      case LogLevel.INFO:
        return this.colorize('INFO', '\x1b[32m');  // Green
      case LogLevel.WARN:
        return this.colorize('WARN', '\x1b[33m');  // Yellow
      case LogLevel.ERROR:
        return this.colorize('ERROR', '\x1b[31m'); // Red
      default:
        return 'UNKNOWN';
    }
  }
  
  /**
   * Colorize a string if colors are enabled
   */
  private colorize(text: string, colorCode: string): string {
    if (!this.config.colors) {
      return text;
    }
    
    return `${colorCode}${text}\x1b[0m`;
  }
  
  /**
   * Log to console
   */
  private logToConsole(message: string, level: LogLevel): void {
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(message);
        break;
      case LogLevel.INFO:
        console.info(message);
        break;
      case LogLevel.WARN:
        console.warn(message);
        break;
      case LogLevel.ERROR:
        console.error(message);
        break;
    }
  }
  
  /**
   * Convert ErrorLevel to LogLevel
   */
  errorLevelToLogLevel(level: ErrorLevel): LogLevel {
    switch (level) {
      case ErrorLevel.DEBUG:
        return LogLevel.DEBUG;
      case ErrorLevel.INFO:
        return LogLevel.INFO;
      case ErrorLevel.WARNING:
        return LogLevel.WARN;
      case ErrorLevel.ERROR:
      case ErrorLevel.CRITICAL:
      case ErrorLevel.FATAL:
        return LogLevel.ERROR;
      default:
        return LogLevel.INFO;
    }
  }
}

// Create singleton logger instance
export const logger = new Logger();

// Configure logger based on environment
if (process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true') {
  logger.setLevel(LogLevel.DEBUG);
} else if (process.env.VERBOSE === 'true') {
  logger.configure({ verbose: true });
} else if (process.env.LOG_LEVEL) {
  const level = parseInt(process.env.LOG_LEVEL, 10);
  if (!isNaN(level) && level >= LogLevel.DEBUG && level <= LogLevel.SILENT) {
    logger.setLevel(level as LogLevel);
  }
}

export default logger; 