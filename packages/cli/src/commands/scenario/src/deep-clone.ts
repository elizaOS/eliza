/**
 * Deep Clone Utilities for Parameter Override System
 *
 * This module provides safe deep cloning functionality with support for
 * complex JavaScript objects, arrays, and edge cases. Required by ticket #5780.
 */

/**
 * Cache for object cloning to handle circular references.
 */
const cloneCache = new WeakMap();

/**
 * Creates a deep clone of an object, preserving data types and handling edge cases.
 *
 * This function provides safe deep cloning that:
 * - Preserves data types (Date, RegExp, etc.)
 * - Handles circular references
 * - Maintains array ordering and object key ordering
 * - Supports nested structures of arbitrary depth
 *
 * @param obj - The object to clone
 * @returns A deep clone of the input object
 * @throws Error if circular references are detected without proper handling
 *
 * @example
 * ```typescript
 * const original = {
 *   name: "test",
 *   nested: { value: 42 },
 *   array: [1, 2, { inner: "data" }],
 *   date: new Date()
 * };
 * const cloned = deepClone(original);
 * // cloned is completely independent of original
 * ```
 */
export function deepClone<T>(obj: T): T {
  // Handle primitive types and null
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Check for circular references
  if (cloneCache.has(obj as any)) {
    throw new Error('Circular reference detected in object to clone');
  }

  // Handle special object types
  if (obj instanceof Date) {
    return new Date(obj.getTime()) as T;
  }

  if (obj instanceof RegExp) {
    return new RegExp(obj.source, obj.flags) as T;
  }

  if (obj instanceof Error) {
    const cloned = new (obj.constructor as any)(obj.message);
    cloned.stack = obj.stack;
    cloned.name = obj.name;
    return cloned as T;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    cloneCache.set(obj as any, true);

    try {
      const cloned = obj.map((item) => deepClone(item)) as T;
      cloneCache.delete(obj as any);
      return cloned;
    } catch (error) {
      cloneCache.delete(obj as any);
      throw error;
    }
  }

  // Handle plain objects
  if (obj.constructor === Object || obj.constructor === undefined) {
    cloneCache.set(obj as any, true);

    try {
      const cloned = {} as T;

      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          (cloned as any)[key] = deepClone((obj as any)[key]);
        }
      }

      cloneCache.delete(obj as any);
      return cloned;
    } catch (error) {
      cloneCache.delete(obj as any);
      throw error;
    }
  }

  // For other object types (custom classes, etc.), attempt basic cloning
  // This may not preserve all properties but is safer than reference copying
  try {
    const cloned = Object.create(Object.getPrototypeOf(obj));
    cloneCache.set(obj as any, true);

    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        (cloned as any)[key] = deepClone((obj as any)[key]);
      }
    }

    cloneCache.delete(obj as any);
    return cloned as T;
  } catch {
    // If all else fails, return the original object
    // This is better than throwing for unknown object types
    return obj;
  }
}

/**
 * Creates a shallow clone of an object.
 * Useful for performance when deep cloning is not necessary.
 *
 * @param obj - The object to clone
 * @returns A shallow clone of the input object
 */
export function shallowClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return [...obj] as T;
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime()) as T;
  }

  if (obj instanceof RegExp) {
    return new RegExp(obj.source, obj.flags) as T;
  }

  // For objects, copy enumerable properties
  return { ...(obj as any) } as T;
}

/**
 * Checks if an object contains circular references.
 * Useful for validation before cloning operations.
 *
 * @param obj - The object to check
 * @returns True if circular references are detected
 */
export function hasCircularReference(obj: any): boolean {
  const visited = new WeakSet();

  function checkCircular(current: any): boolean {
    if (current === null || typeof current !== 'object') {
      return false;
    }

    if (visited.has(current)) {
      return true;
    }

    visited.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        if (checkCircular(item)) {
          return true;
        }
      }
    } else {
      for (const key in current) {
        if (current.hasOwnProperty(key)) {
          if (checkCircular(current[key])) {
            return true;
          }
        }
      }
    }

    return false;
  }

  return checkCircular(obj);
}

/**
 * Creates a deep clone with a maximum depth limit.
 * Useful for preventing stack overflow with very deep objects.
 *
 * @param obj - The object to clone
 * @param maxDepth - Maximum depth to clone (default: 50)
 * @returns A deep clone limited to the specified depth
 */
export function deepCloneWithLimit<T>(obj: T, maxDepth: number = 50): T {
  function cloneWithDepth(current: any, depth: number): any {
    if (depth >= maxDepth) {
      // At max depth, return shallow copy for objects/arrays
      if (typeof current === 'object' && current !== null) {
        if (Array.isArray(current)) {
          return [...current];
        }
        return { ...current };
      }
      return current;
    }

    if (current === null || typeof current !== 'object') {
      return current;
    }

    if (current instanceof Date) {
      return new Date(current.getTime());
    }

    if (current instanceof RegExp) {
      return new RegExp(current.source, current.flags);
    }

    if (Array.isArray(current)) {
      return current.map((item) => cloneWithDepth(item, depth + 1));
    }

    const cloned: any = {};
    for (const key in current) {
      if (current.hasOwnProperty(key)) {
        cloned[key] = cloneWithDepth(current[key], depth + 1);
      }
    }

    return cloned;
  }

  return cloneWithDepth(obj, 0);
}

/**
 * Performs a structural clone using JSON serialization.
 * Fast but limited to JSON-serializable objects.
 *
 * @param obj - The object to clone
 * @returns A deep clone via JSON serialization
 * @throws Error if object is not JSON-serializable
 */
export function jsonClone<T>(obj: T): T {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (error) {
    throw new Error(
      `Object is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Clears any internal caching used by the cloning functions.
 * Useful for testing and memory management.
 */
export function clearCloneCache(): void {
  // WeakMap doesn't need explicit clearing, but this provides
  // a consistent API for cache management
}

/**
 * Options for advanced cloning behavior.
 */
export interface CloneOptions {
  /** Maximum depth to clone (prevents stack overflow) */
  maxDepth?: number;
  /** Whether to handle circular references (default: true) */
  handleCircular?: boolean;
  /** Whether to preserve special object types like Date, RegExp (default: true) */
  preserveTypes?: boolean;
  /** Custom cloning function for specific object types */
  customCloners?: Map<any, (obj: any) => any>;
}

/**
 * Advanced deep clone with configurable options.
 *
 * @param obj - The object to clone
 * @param options - Cloning options
 * @returns A deep clone with the specified behavior
 */
export function advancedDeepClone<T>(obj: T, options: CloneOptions = {}): T {
  const {
    maxDepth = 50,
    handleCircular = true,
    preserveTypes = true,
    customCloners = new Map(),
  } = options;

  const visited = handleCircular ? new WeakMap() : null;

  function cloneAdvanced(current: any, depth: number): any {
    // Check depth limit
    if (depth >= maxDepth) {
      return current;
    }

    // Handle primitives and null
    if (current === null || typeof current !== 'object') {
      return current;
    }

    // Check for circular references
    if (visited && visited.has(current)) {
      return visited.get(current);
    }

    // Check for custom cloners
    for (const [type, cloner] of customCloners) {
      if (current instanceof type) {
        const cloned = cloner(current);
        if (visited) visited.set(current, cloned);
        return cloned;
      }
    }

    // Handle special types
    if (preserveTypes) {
      if (current instanceof Date) {
        const cloned = new Date(current.getTime());
        if (visited) visited.set(current, cloned);
        return cloned;
      }

      if (current instanceof RegExp) {
        const cloned = new RegExp(current.source, current.flags);
        if (visited) visited.set(current, cloned);
        return cloned;
      }
    }

    // Handle arrays
    if (Array.isArray(current)) {
      const cloned: any[] = [];
      if (visited) visited.set(current, cloned);

      for (let i = 0; i < current.length; i++) {
        cloned[i] = cloneAdvanced(current[i], depth + 1);
      }

      return cloned;
    }

    // Handle objects
    const cloned: any = {};
    if (visited) visited.set(current, cloned);

    for (const key in current) {
      if (current.hasOwnProperty(key)) {
        cloned[key] = cloneAdvanced(current[key], depth + 1);
      }
    }

    return cloned;
  }

  return cloneAdvanced(obj, 0);
}
