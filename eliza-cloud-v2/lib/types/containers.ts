/**
 * Container-related type definitions
 */

/**
 * Log level for container logs.
 */
export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Parsed log entry from container logs.
 */
export interface ParsedLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  metadata?: Record<string, unknown>;
}
