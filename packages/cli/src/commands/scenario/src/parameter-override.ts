/**
 * Parameter Override System for Scenario Matrix Testing
 * 
 * This module provides functionality to dynamically override parameters in scenario
 * configurations using dot-notation paths and array indexing.
 */

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
 * Represents a parsed parameter path with segments and metadata.
 */
export interface ParameterPath {
    /** Array of path segments, where numbers represent array indices */
    segments: (string | number)[];
    /** Whether the path contains array access notation */
    hasArrayAccess: boolean;
    /** Original path string */
    originalPath: string;
}

/**
 * Parses a dot-notation parameter path into segments.
 * 
 * Supports:
 * - Simple paths: "character.name"
 * - Nested paths: "character.llm.model"
 * - Array access: "run[0].input"
 * - Mixed access: "plugins[1].config.apiKey"
 * 
 * @param path - The dot-notation path to parse
 * @returns Parsed path object with segments
 * @throws Error if the path is malformed
 * 
 * @example
 * ```typescript
 * parseParameterPath("character.llm.model")
 * // Returns: { segments: ["character", "llm", "model"], hasArrayAccess: false }
 * 
 * parseParameterPath("run[0].input")
 * // Returns: { segments: ["run", 0, "input"], hasArrayAccess: true }
 * ```
 */
export function parseParameterPath(path: string): ParameterPath {
    if (!path || typeof path !== 'string') {
        throw new Error('Parameter path must be a non-empty string');
    }

    if (path.startsWith('.') || path.endsWith('.')) {
        throw new Error('Parameter path cannot start or end with a dot');
    }

    if (path === '.') {
        throw new Error('Parameter path cannot be just a dot');
    }

    const segments: (string | number)[] = [];
    let hasArrayAccess = false;

    // Split by dots first, then handle array notation
    const dotSegments = path.split('.');

    for (const segment of dotSegments) {
        if (!segment) {
            throw new Error('Parameter path cannot contain empty segments');
        }

        // Check for array notation like "run[0]" or "plugins[1]"
        const arrayMatch = segment.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);

        if (arrayMatch) {
            const [, property, indexStr] = arrayMatch;

            // Validate that it's a valid numeric index
            if (!/^\d+$/.test(indexStr)) {
                throw new Error(`Invalid array index: ${indexStr}`);
            }

            const index = parseInt(indexStr, 10);

            if (isNaN(index) || index < 0) {
                throw new Error(`Invalid array index: ${indexStr}`);
            }

            segments.push(property);
            segments.push(index);
            hasArrayAccess = true;
        } else {
            // Validate that the segment is a valid property name
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment)) {
                throw new Error(`Invalid property name in path: ${segment}`);
            }

            segments.push(segment);
        }
    }

    return {
        segments,
        hasArrayAccess,
        originalPath: path
    };
}

/**
 * Validates that a parameter path exists in the given object.
 * 
 * @param obj - The object to validate against
 * @param path - The dot-notation path to validate
 * @returns True if the path exists, false otherwise
 * 
 * @example
 * ```typescript
 * const scenario = { character: { llm: { model: "gpt-4" } } };
 * validateParameterPath(scenario, "character.llm.model"); // true
 * validateParameterPath(scenario, "character.nonexistent"); // false
 * ```
 */
export function validateParameterPath(obj: any, path: string): boolean {
    if (!obj || typeof obj !== 'object') {
        return false;
    }

    try {
        const parsedPath = parseParameterPath(path);
        let current = obj;

        for (let i = 0; i < parsedPath.segments.length; i++) {
            const segment = parsedPath.segments[i];

            if (typeof segment === 'number') {
                // Array index
                if (!Array.isArray(current) || segment >= current.length || segment < 0) {
                    return false;
                }
                current = current[segment];
            } else {
                // Object property
                if (!current || typeof current !== 'object' || !(segment in current)) {
                    return false;
                }
                current = current[segment];
            }
        }

        return true;
    } catch {
        return false;
    }
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
                throw new Error(`Expected array at path segment, but found ${typeof current} in path: ${path}`);
            }
            if (segment >= current.length || segment < 0) {
                throw new Error(`Array index out of bounds: ${segment} in path: ${path}`);
            }
            current = current[segment];
        } else {
            // Object property
            if (!current || typeof current !== 'object') {
                throw new Error(`Expected object at path segment, but found ${typeof current} in path: ${path}`);
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
                throw new Error(`Expected array at path segment, but found ${typeof current} in path: ${path}`);
            }
            if (segment >= current.length || segment < 0) {
                throw new Error(`Array index out of bounds: ${segment} in path: ${path}`);
            }
            current = current[segment];
        } else {
            // Object property
            if (!current || typeof current !== 'object') {
                throw new Error(`Expected object at path segment, but found ${typeof current} in path: ${path}`);
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
            throw new Error(`Expected array for final segment, but found ${typeof current} in path: ${path}`);
        }
        if (finalSegment >= current.length || finalSegment < 0) {
            throw new Error(`Array index out of bounds: ${finalSegment} in path: ${path}`);
        }
        current[finalSegment] = value;
    } else {
        // Object property
        if (!current || typeof current !== 'object') {
            throw new Error(`Expected object for final segment, but found ${typeof current} in path: ${path}`);
        }
        current[finalSegment] = value;
    }
}

/**
 * Creates a deep copy of an object to ensure immutability.
 * 
 * @param obj - The object to clone
 * @returns A deep copy of the object
 */
export function deepClone<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (obj instanceof Date) {
        return new Date(obj.getTime()) as T;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => deepClone(item)) as T;
    }

    if (typeof obj === 'object') {
        const cloned = {} as T;
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                cloned[key] = deepClone(obj[key]);
            }
        }
        return cloned;
    }

    return obj;
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
export function applyParameterOverrides(
    baseScenario: any,
    overrides: ParameterOverride[]
): any {
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
        value
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
        if (!validateParameterPath(baseScenario, axis.parameter)) {
            invalidPaths.push(axis.parameter);
        }
    }

    return {
        valid: invalidPaths.length === 0,
        invalidPaths
    };
}
