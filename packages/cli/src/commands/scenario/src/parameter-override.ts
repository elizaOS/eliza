/**
 * Parameter Override System for Scenario Matrix Testing
 *
 * This module provides functionality to dynamically override parameters in scenario
 * configurations using dot-notation paths and array indexing.
 *
 * Core implementation for ticket #5780.
 */

import { parseParameterPath } from './path-parser';
import { deepClone } from './deep-clone';

// Re-export functions from modules for backward compatibility
export {
  parseParameterPath,
  isValidPathSyntax,
  normalizeParameterPath,
  ParameterPath,
} from './path-parser';
export { deepClone, hasCircularReference, deepCloneWithLimit } from './deep-clone';

/**
 * Represents a single parameter override.
 */
export interface ParameterOverride {
  /** Dot-notation path to the parameter (e.g., "character.llm.model" or "run[0].input") */
  path: string;
  /** The value to set at the specified path */
  value: any;
}

/**
 * Result of parameter path validation with detailed feedback.
 * Required by ticket #5780.
 */
export interface ValidationResult {
  /** Whether the path is valid and can be used for overrides */
  isValid: boolean;
  /** Error message if validation failed */
  error?: string;
  /** Suggested correction for common mistakes */
  suggestion?: string;
  /** Whether the path exists in the target object */
  pathExists: boolean;
  /** Type of the value at the target path */
  targetType?: string;
}

/**
 * Details about a single parameter override operation.
 * Used for tracking and debugging override applications.
 */
export interface OverrideOperation {
  /** The dot-notation path that was modified */
  path: string;
  /** The new value that was set */
  value: any;
  /** The original value that was replaced (if any) */
  originalValue?: any;
  /** Whether this operation created new intermediate objects */
  wasCreated: boolean;
}

/**
 * Complete result of applying parameter overrides.
 * Includes the modified scenario and metadata about operations.
 */
export interface OverrideResult {
  /** The scenario object with overrides applied */
  scenario: any;
  /** Details about each override operation performed */
  operations: OverrideOperation[];
  /** Any warnings generated during override application */
  warnings: string[];
}

// ParameterPath interface is now imported from './path-parser'

// parseParameterPath function is now imported from './path-parser'

/**
 * Validates that a parameter path exists in the given object with detailed feedback.
 * This enhanced version returns ValidationResult as required by ticket #5780.
 *
 * @param obj - The object to validate against
 * @param path - The dot-notation path to validate
 * @returns ValidationResult with detailed information about the path
 *
 * @example
 * ```typescript
 * const scenario = { character: { llm: { model: "gpt-4" } } };
 * const result = validateParameterPath(scenario, "character.llm.model");
 * // result.isValid === true, result.targetType === "string"
 *
 * const invalid = validateParameterPath(scenario, "character.nonexistent");
 * // invalid.isValid === false, invalid.suggestion === "Available properties: llm"
 * ```
 */
export function validateParameterPath(obj: any, path: string): ValidationResult {
  if (!obj || typeof obj !== 'object') {
    return {
      isValid: false,
      error: 'Target object is null or not an object',
      pathExists: false,
      targetType: typeof obj,
    };
  }

  try {
    const parsedPath = parseParameterPath(path);
    let current = obj;
    let currentPath = '';

    for (let i = 0; i < parsedPath.segments.length; i++) {
      const segment = parsedPath.segments[i];

      if (typeof segment === 'number') {
        currentPath += `[${segment}]`;

        if (!Array.isArray(current)) {
          return {
            isValid: false,
            error: `Expected array at path '${currentPath}', but found ${typeof current}`,
            pathExists: false,
            targetType: typeof current,
          };
        }

        if (segment >= current.length || segment < 0) {
          return {
            isValid: false,
            error: `Array index ${segment} is out of bounds at path '${currentPath}' (array length: ${current.length})`,
            suggestion:
              segment >= current.length
                ? `Use index 0-${current.length - 1} or add more elements to the array`
                : 'Array indices must be non-negative',
            pathExists: false,
            targetType: 'array',
          };
        }

        current = current[segment];
      } else {
        currentPath += currentPath ? `.${segment}` : segment;

        if (!current || typeof current !== 'object') {
          return {
            isValid: false,
            error: `Expected object at path '${currentPath}', but found ${typeof current}`,
            pathExists: false,
            targetType: typeof current,
          };
        }

        if (!(segment in current)) {
          const availableProps = Object.keys(current).slice(0, 5);
          const suggestion =
            availableProps.length > 0
              ? `Available properties: ${availableProps.join(', ')}${Object.keys(current).length > 5 ? '...' : ''}`
              : 'Object has no properties';

          return {
            isValid: false,
            error: `Property '${segment}' does not exist at path '${currentPath}'`,
            suggestion,
            pathExists: false,
            targetType: 'object',
          };
        }

        current = current[segment];
      }
    }

    return {
      isValid: true,
      pathExists: true,
      targetType: Array.isArray(current) ? 'array' : typeof current,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    let suggestion = '';

    if (errorMessage.includes('bracket')) {
      suggestion = 'Use bracket notation for arrays: run[0].input instead of run.0.input';
    } else if (errorMessage.includes('invalid')) {
      suggestion = 'Check path syntax: use dots for objects and brackets for arrays';
    }

    return {
      isValid: false,
      error: `Invalid path format: ${errorMessage}`,
      suggestion,
      pathExists: false,
    };
  }
}

/**
 * Legacy function for backward compatibility.
 * Returns boolean like the original function.
 */
export function validateParameterPathLegacy(obj: any, path: string): boolean {
  const result = validateParameterPath(obj, path);
  return result.isValid;
}

/**
 * Gets the value at a specific parameter path in an object.
 *
 * @param obj - The object to read from
 * @param path - The dot-notation path
 * @returns The value at the path
 * @throws Error if the path doesn't exist
 */
export function getValueAtPath(obj: any, path: string): any {
  const parsedPath = parseParameterPath(path);
  let current = obj;

  for (let i = 0; i < parsedPath.segments.length; i++) {
    const segment = parsedPath.segments[i];

    if (typeof segment === 'number') {
      // Array index
      if (!Array.isArray(current)) {
        throw new Error(
          `Expected array at path segment, but found ${typeof current} in path: ${path}`
        );
      }
      if (segment >= current.length || segment < 0) {
        throw new Error(`Array index out of bounds: ${segment} in path: ${path}`);
      }
      current = current[segment];
    } else {
      // Object property
      if (!current || typeof current !== 'object') {
        throw new Error(
          `Expected object at path segment, but found ${typeof current} in path: ${path}`
        );
      }
      if (!(segment in current)) {
        throw new Error(`Property '${segment}' not found in path: ${path}`);
      }
      current = current[segment];
    }
  }

  return current;
}

/**
 * Sets a value at a specific parameter path in an object.
 * This function modifies the object in place.
 *
 * @param obj - The object to modify
 * @param path - The dot-notation path
 * @param value - The value to set
 * @throws Error if the path doesn't exist or is invalid
 */
export function setValueAtPath(obj: any, path: string, value: any): void {
  const parsedPath = parseParameterPath(path);
  let current = obj;

  // Navigate to the parent of the target property
  for (let i = 0; i < parsedPath.segments.length - 1; i++) {
    const segment = parsedPath.segments[i];

    if (typeof segment === 'number') {
      // Array index
      if (!Array.isArray(current)) {
        throw new Error(
          `Expected array at path segment, but found ${typeof current} in path: ${path}`
        );
      }
      if (segment >= current.length || segment < 0) {
        throw new Error(`Array index out of bounds: ${segment} in path: ${path}`);
      }
      current = current[segment];
    } else {
      // Object property
      if (!current || typeof current !== 'object') {
        throw new Error(
          `Expected object at path segment, but found ${typeof current} in path: ${path}`
        );
      }
      if (!(segment in current)) {
        throw new Error(`Property '${segment}' not found in path: ${path}`);
      }
      current = current[segment];
    }
  }

  // Set the final value
  const finalSegment = parsedPath.segments[parsedPath.segments.length - 1];

  if (typeof finalSegment === 'number') {
    // Array index
    if (!Array.isArray(current)) {
      throw new Error(
        `Expected array for final segment, but found ${typeof current} in path: ${path}`
      );
    }
    if (finalSegment >= current.length || finalSegment < 0) {
      throw new Error(`Array index out of bounds: ${finalSegment} in path: ${path}`);
    }
    current[finalSegment] = value;
  } else {
    // Object property
    if (!current || typeof current !== 'object') {
      throw new Error(
        `Expected object for final segment, but found ${typeof current} in path: ${path}`
      );
    }
    current[finalSegment] = value;
  }
}

// deepClone function is now imported from './deep-clone'

/**
 * Applies a single parameter override to a scenario object.
 * This is the core function required by ticket #5780.
 *
 * @param scenario - The scenario object to modify
 * @param path - Dot-notation path to the parameter (e.g., "character.llm.model")
 * @param value - The value to set at the specified path
 * @returns A deep clone of the scenario with the override applied
 * @throws Error if the path is invalid or cannot be applied
 *
 * @example
 * ```typescript
 * const scenario = { character: { llm: { model: "gpt-4" } } };
 * const result = applyParameterOverride(scenario, "character.llm.model", "gpt-3.5-turbo");
 * // result.character.llm.model === "gpt-3.5-turbo"
 * // original scenario is unchanged
 * ```
 */
export function applyParameterOverride(scenario: any, path: string, value: any): any {
  // Create a deep clone to avoid mutating the original
  const clonedScenario = deepClone(scenario);

  // Apply the single override
  setValueAtPath(clonedScenario, path, value);

  return clonedScenario;
}

/**
 * Applies a set of parameter overrides from a Record<string, any> format.
 * This is the batch function required by ticket #5780.
 *
 * @param baseScenario - The base scenario object to modify
 * @param overrides - Record mapping parameter paths to values
 * @returns A deep clone of the scenario with all overrides applied
 * @throws Error if any path is invalid or cannot be applied
 *
 * @example
 * ```typescript
 * const overrides = {
 *   "character.llm.model": "gpt-3.5-turbo",
 *   "run[0].input": "Hello world"
 * };
 * const result = applyMatrixOverrides(baseScenario, overrides);
 * ```
 */
export function applyMatrixOverrides(baseScenario: any, overrides: Record<string, any>): any {
  // Convert Record to ParameterOverride array
  const parameterOverrides: ParameterOverride[] = Object.entries(overrides).map(
    ([path, value]) => ({
      path,
      value,
    })
  );

  // Use the existing batch function
  return applyParameterOverrides(baseScenario, parameterOverrides);
}

/**
 * Applies parameter overrides to a base scenario object.
 *
 * This is the main function for the parameter override system. It takes a base
 * scenario object and an array of parameter overrides, and returns a new scenario
 * object with the overrides applied.
 *
 * The function:
 * 1. Creates a deep copy of the base scenario to ensure immutability
 * 2. Validates each override path exists in the scenario
 * 3. Applies each override in order
 * 4. Returns the modified scenario
 *
 * @param baseScenario - The base scenario object to modify
 * @param overrides - Array of parameter overrides to apply
 * @returns A new scenario object with overrides applied
 * @throws Error if any override path is invalid
 *
 * @example
 * ```typescript
 * const baseScenario = {
 *   character: { llm: { model: "gpt-4" } },
 *   run: [{ input: "original" }]
 * };
 *
 * const overrides = [
 *   { path: "character.llm.model", value: "gpt-3.5-turbo" },
 *   { path: "run[0].input", value: "modified" }
 * ];
 *
 * const result = applyParameterOverrides(baseScenario, overrides);
 * // result.character.llm.model === "gpt-3.5-turbo"
 * // result.run[0].input === "modified"
 * // baseScenario is unchanged
 * ```
 */
export function applyParameterOverrides(baseScenario: any, overrides: ParameterOverride[]): any {
  if (!baseScenario || typeof baseScenario !== 'object') {
    throw new Error('Base scenario must be a valid object');
  }

  if (!Array.isArray(overrides)) {
    throw new Error('Overrides must be an array');
  }

  // Create a deep copy to ensure immutability
  const modifiedScenario = deepClone(baseScenario);

  // Apply each override
  for (const override of overrides) {
    if (!override || typeof override !== 'object') {
      throw new Error('Each override must be an object with path and value properties');
    }

    if (!override.path || typeof override.path !== 'string') {
      throw new Error('Override path must be a non-empty string');
    }

    // Validate that the path exists in the base scenario
    // For more specific error messages, check manually
    try {
      const parsedPath = parseParameterPath(override.path);
      let current = modifiedScenario;

      for (let i = 0; i < parsedPath.segments.length; i++) {
        const segment = parsedPath.segments[i];

        if (typeof segment === 'number') {
          // Array index
          if (!Array.isArray(current)) {
            throw new Error(`Expected array but found ${typeof current} at path: ${override.path}`);
          }
          if (segment >= current.length || segment < 0) {
            throw new Error(`Array index out of bounds: ${segment} in path: ${override.path}`);
          }
          current = current[segment];
        } else {
          // Object property
          if (!current || typeof current !== 'object' || !(segment in current)) {
            throw new Error(`Invalid parameter path: ${override.path}`);
          }
          current = current[segment];
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Invalid parameter path: ${override.path}`);
    }

    try {
      // Apply the override
      setValueAtPath(modifiedScenario, override.path, override.value);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to apply override for path '${override.path}': ${error.message}`);
      }
      throw error;
    }
  }

  return modifiedScenario;
}

/**
 * Converts a parameter combinations object to ParameterOverride array.
 * This is a utility function for integrating with the matrix system.
 *
 * @param combination - Object mapping parameter paths to values
 * @returns Array of ParameterOverride objects
 *
 * @example
 * ```typescript
 * const combination = {
 *   "character.llm.model": "gpt-4",
 *   "run[0].input": "test input"
 * };
 *
 * const overrides = combinationToOverrides(combination);
 * // Returns: [
 * //   { path: "character.llm.model", value: "gpt-4" },
 * //   { path: "run[0].input", value: "test input" }
 * // ]
 * ```
 */
export function combinationToOverrides(combination: Record<string, any>): ParameterOverride[] {
  return Object.entries(combination).map(([path, value]) => ({
    path,
    value,
  }));
}

/**
 * Validates that all parameter paths in a matrix configuration are valid
 * for a given base scenario.
 *
 * @param baseScenario - The base scenario to validate against
 * @param matrixAxes - Array of matrix axes with parameter paths
 * @returns Validation result with any invalid paths
 */
export function validateMatrixParameterPaths(
  baseScenario: any,
  matrixAxes: Array<{ parameter: string; values: any[] }>
): { valid: boolean; invalidPaths: string[] } {
  const invalidPaths: string[] = [];

  for (const axis of matrixAxes) {
    const validation = validateParameterPath(baseScenario, axis.parameter);
    if (!validation.isValid) {
      invalidPaths.push(axis.parameter);
    }
  }

  return {
    valid: invalidPaths.length === 0,
    invalidPaths,
  };
}
