/**
 * API Package Types
 *
 * Shared types for API middleware and utilities
 */

/**
 * JSON-serializable value types
 * Note: undefined is included for optional properties - it's omitted during JSON serialization
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

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

/**
 * Generic key-value record with string keys
 */
export type StringRecord<T = JsonValue> = Record<string, T>;
