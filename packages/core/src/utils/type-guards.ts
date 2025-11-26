/**
 * Type guard utilities for runtime type checking
 * These functions help TypeScript narrow types safely
 */

import { isBuffer } from './buffer';

/**
 * Check if a value is a plain object (not null, array, buffer, Date, or RegExp)
 * Type guard that narrows the type to Record<string, unknown>
 *
 * @param value - The value to check
 * @returns True if the value is a plain object
 *
 * @example
 * ```typescript
 * const data: unknown = { name: 'test' };
 * if (isPlainObject(data)) {
 *   // TypeScript knows data is Record<string, unknown>
 *   console.log(data.name);
 * }
 * ```
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  if (isBuffer(value)) {
    return false;
  }
  if (value instanceof Date) {
    return false;
  }
  if (value instanceof RegExp) {
    return false;
  }
  return true;
}
