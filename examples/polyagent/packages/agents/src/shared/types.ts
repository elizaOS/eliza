/**
 * Shared Type Definitions for @polyagent/agents
 *
 * Common types used throughout the agents package.
 *
 * @packageDocumentation
 */

/**
 * JSON-serializable value types
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Generic key-value record with string keys
 */
export type StringRecord<T = JsonValue> = Record<string, T>;

/**
 * Log data payload - structured data for logging
 */
export type LogData =
  | JsonValue
  | StringRecord
  | Error
  | { [key: string]: JsonValue | unknown }
  | unknown;

/**
 * Error-like object that may have a message property
 */
export interface ErrorLike {
  message?: string;
  name?: string;
  stack?: string;
  code?: string | number;
  [key: string]: JsonValue | undefined;
}
