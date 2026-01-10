/**
 * Type Declarations
 * 
 * Re-exports and defines common types used throughout the application.
 * This helps centralize type definitions and avoid duplication.
 */

/**
 * Node.js process error with code
 */
export interface ErrnoException extends Error {
  errno?: number;
  code?: string;
  path?: string;
  syscall?: string;
}

/**
 * Node.js timeout handle
 */
export interface Timeout {
  hasRef(): boolean;
  ref(): Timeout;
  refresh(): Timeout;
  unref(): Timeout;
}

/**
 * JSON primitive types
 */
export type JSONPrimitive = string | number | boolean | null;

/**
 * JSON object type
 */
export type JSONObject = { [key: string]: JSONValue };

/**
 * JSON array type
 */
export type JSONArray = JSONValue[];

/**
 * JSON value type
 */
export type JSONValue = JSONPrimitive | JSONObject | JSONArray;

/**
 * Record with string keys and any values
 */
export type AnyRecord = Record<string, any>;

/**
 * Basic callback function type
 */
export type Callback<T = void> = (error?: Error | null, result?: T) => void;

/**
 * Async function that returns a Promise
 */
export type AsyncFunction<T, A extends any[]> = (...args: A) => Promise<T>;

/**
 * Function with a timeout
 */
export interface TimedFunction<T, A extends any[]> {
  (...args: A): Promise<T>;
  timeout: number;
}

/**
 * Optional properties in T
 */
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Required properties in T
 */
export type RequiredFields<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

/**
 * Deep partial type
 */
export type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

/**
 * Result of an operation
 */
export interface Result<T, E = Error> {
  success: boolean;
  value?: T;
  error?: E;
}

/**
 * Success result
 */
export type Success<T> = {
  success: true;
  value: T;
};

/**
 * Error result
 */
export type Failure<E = Error> = {
  success: false;
  error: E;
};

/**
 * Either success or failure
 */
export type Either<T, E = Error> = Success<T> | Failure<E>;

/**
 * Create a success result
 */
export function success<T>(value: T): Success<T> {
  return { success: true, value };
}

/**
 * Create a failure result
 */
export function failure<E = Error>(error: E): Failure<E> {
  return { success: false, error };
} 