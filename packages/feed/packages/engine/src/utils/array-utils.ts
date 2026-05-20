/**
 * Array Utilities
 *
 * Safe array access utilities to replace non-null assertions (`array[0]!`).
 * First principles: Arrays can be empty. Handle it once, correctly.
 *
 * @module engine/utils/array-utils
 */

/**
 * Get the first element of an array, or undefined if empty.
 * Safe alternative to `array[0]` that explicitly returns undefined.
 *
 * @param arr - Array to get first element from
 * @returns The first element, or undefined if array is empty
 *
 * @example
 * ```typescript
 * const items = [1, 2, 3];
 * const first = first(items); // 1
 *
 * const empty: number[] = [];
 * const none = first(empty); // undefined
 * ```
 */
export function first<T>(arr: readonly T[]): T | undefined {
  return arr[0];
}

/**
 * Get the first element of an array, throwing if empty.
 * Safe alternative to `array[0]!` with explicit error handling.
 *
 * @param arr - Array to get first element from
 * @param message - Optional custom error message
 * @returns The first element (guaranteed non-undefined)
 * @throws Error if array is empty
 *
 * @example
 * ```typescript
 * const items = [1, 2, 3];
 * const first = firstOrThrow(items); // 1
 *
 * const empty: number[] = [];
 * firstOrThrow(empty); // throws Error('Expected non-empty array')
 * firstOrThrow(empty, 'No users found'); // throws Error('No users found')
 * ```
 */
export function firstOrThrow<T>(arr: readonly T[], message?: string): T {
  if (arr.length === 0) {
    throw new Error(message ?? 'Expected non-empty array');
  }
  return arr[0] as T;
}

/**
 * Get the last element of an array, or undefined if empty.
 *
 * @param arr - Array to get last element from
 * @returns The last element, or undefined if array is empty
 *
 * @example
 * ```typescript
 * const items = [1, 2, 3];
 * const last = last(items); // 3
 * ```
 */
export function last<T>(arr: readonly T[]): T | undefined {
  return arr[arr.length - 1];
}

/**
 * Get the last element of an array, throwing if empty.
 *
 * @param arr - Array to get last element from
 * @param message - Optional custom error message
 * @returns The last element (guaranteed non-undefined)
 * @throws Error if array is empty
 */
export function lastOrThrow<T>(arr: readonly T[], message?: string): T {
  if (arr.length === 0) {
    throw new Error(message ?? 'Expected non-empty array');
  }
  return arr[arr.length - 1] as T;
}

/**
 * Assert that an array is non-empty (type narrowing).
 * After calling, TypeScript knows the array has at least one element.
 *
 * @param arr - Array to assert is non-empty
 * @param context - Optional context for error message
 * @throws Error if array is empty
 *
 * @example
 * ```typescript
 * const items: number[] = getItems();
 * assertNonEmpty(items, 'items from getItems()');
 * // TypeScript now knows items is [number, ...number[]]
 * const first = items[0]; // number, not number | undefined
 * ```
 */
export function assertNonEmpty<T>(
  arr: readonly T[],
  context?: string
): asserts arr is readonly [T, ...T[]] {
  if (arr.length === 0) {
    throw new Error(`Empty array${context ? `: ${context}` : ''}`);
  }
}

/**
 * Check if an array is non-empty (type guard).
 * Use when you want to check without throwing.
 *
 * @param arr - Array to check
 * @returns True if array has at least one element
 *
 * @example
 * ```typescript
 * const items: number[] = getItems();
 * if (isNonEmpty(items)) {
 *   // TypeScript knows items[0] is number
 *   console.log(items[0]);
 * }
 * ```
 */
export function isNonEmpty<T>(arr: readonly T[]): arr is readonly [T, ...T[]] {
  return arr.length > 0;
}

/**
 * Get element at index, or undefined if out of bounds.
 * Safe alternative to `array[index]` with explicit undefined handling.
 *
 * @param arr - Array to get element from
 * @param index - Index to access (supports negative indices)
 * @returns The element at index, or undefined if out of bounds
 *
 * @example
 * ```typescript
 * const items = [1, 2, 3];
 * at(items, 0);  // 1
 * at(items, -1); // 3
 * at(items, 10); // undefined
 * ```
 */
export function at<T>(arr: readonly T[], index: number): T | undefined {
  // Handle negative indices
  const idx = index < 0 ? arr.length + index : index;
  if (idx < 0 || idx >= arr.length) return undefined;
  return arr[idx];
}

/**
 * Get element at index, throwing if out of bounds.
 *
 * @param arr - Array to get element from
 * @param index - Index to access (supports negative indices)
 * @param message - Optional custom error message
 * @returns The element at index (guaranteed non-undefined)
 * @throws Error if index is out of bounds
 */
export function atOrThrow<T>(
  arr: readonly T[],
  index: number,
  message?: string
): T {
  // Normalize negative indices
  const normalized = index < 0 ? arr.length + index : index;
  if (normalized < 0 || normalized >= arr.length) {
    throw new Error(
      message ??
        `Index ${index} out of bounds for array of length ${arr.length}`
    );
  }
  return arr[normalized] as T;
}
