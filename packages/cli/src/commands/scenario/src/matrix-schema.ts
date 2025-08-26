import { z } from 'zod';

/**
 * Schema for defining a single axis of variation in a scenario matrix.
 * Each axis specifies a parameter path and the values to test for that parameter.
 */
const MatrixAxisSchema = z.object({
  /**
   * The target field in the base scenario to override, specified using dot-notation.
   * Examples: "character.llm.model", "run[0].input", "setup.mocks[0].response.success"
   */
  parameter: z.string().min(1, 'Parameter path cannot be empty'),

  /**
   * A list of values to be substituted for the specified parameter.
   * Values can be of any type (string, number, boolean, object, array, null).
   */
  values: z.array(z.any()).min(1, 'Values array must contain at least 1 element'),
});

/**
 * Schema for the complete scenario matrix configuration.
 * This defines how to run a base scenario across multiple parameter combinations.
 */
export const MatrixConfigSchema = z.object({
  /**
   * A human-readable name for the test matrix.
   * Example: "GitHub Issue Prompt Robustness"
   */
  name: z.string().min(1, 'Name cannot be empty'),

  /**
   * A longer description of the test's goals (optional).
   */
  description: z.string().optional(),

  /**
   * The file path (relative to the project root) to the base .scenario.yaml file
   * to be used in each run.
   */
  base_scenario: z.string().min(1, 'Base scenario path cannot be empty'),

  /**
   * The number of times to execute each unique combination of parameters
   * to check for consistency. Defaults to 1.
   */
  runs_per_combination: z
    .number()
    .int()
    .min(1, 'Runs per combination must be greater than or equal to 1')
    .default(1),

  /**
   * An array of objects defining the axes of variation.
   * Each axis specifies a parameter to vary and the values to test.
   */
  matrix: z.array(MatrixAxisSchema).min(1, 'Matrix must contain at least 1 axis'),
});

/**
 * TypeScript interface for a matrix axis, inferred from the Zod schema.
 */
export type MatrixAxis = z.infer<typeof MatrixAxisSchema>;

/**
 * TypeScript interface for the complete matrix configuration, inferred from the Zod schema.
 */
export type MatrixConfig = z.infer<typeof MatrixConfigSchema>;

/**
 * Validation result type for successful validation.
 */
interface ValidationSuccess {
  success: true;
  data: MatrixConfig;
}

/**
 * Validation result type for failed validation.
 */
interface ValidationError {
  success: false;
  error: z.ZodError<MatrixConfig>;
}

/**
 * Union type for validation results.
 */
export type ValidationResult = ValidationSuccess | ValidationError;

/**
 * Validates a matrix configuration object against the schema.
 *
 * @param config - The configuration object to validate (typically parsed from YAML)
 * @returns ValidationResult - Contains either the validated data or detailed error information
 *
 * @example
 * ```typescript
 * const config = {
 *   name: "Test Matrix",
 *   base_scenario: "test.scenario.yaml",
 *   matrix: [
 *     {
 *       parameter: "character.llm.model",
 *       values: ["gpt-4", "claude-3"]
 *     }
 *   ]
 * };
 *
 * const result = validateMatrixConfig(config);
 * if (result.success) {
 *   console.log("Valid configuration:", result.data);
 * } else {
 *   console.error("Validation errors:", result.error.format());
 * }
 * ```
 */
export function validateMatrixConfig(config: unknown): ValidationResult {
  const result = MatrixConfigSchema.safeParse(config);

  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  } else {
    return {
      success: false,
      error: result.error,
    };
  }
}

/**
 * Calculates the total number of parameter combinations in a matrix configuration.
 * This is the Cartesian product of all axis values.
 *
 * @param config - A validated matrix configuration
 * @returns The total number of combinations that will be generated
 *
 * @example
 * ```typescript
 * const config = {
 *   name: "Test",
 *   base_scenario: "test.yaml",
 *   matrix: [
 *     { parameter: "model", values: ["gpt-4", "claude-3"] },      // 2 values
 *     { parameter: "temperature", values: [0.1, 0.5, 0.9] }      // 3 values
 *   ]
 * };
 *
 * const total = calculateTotalCombinations(config); // Returns 6 (2 * 3)
 * ```
 */
export function calculateTotalCombinations(config: MatrixConfig): number {
  return config.matrix.reduce((total, axis) => total * axis.values.length, 1);
}

/**
 * Calculates the total number of test runs that will be executed.
 * This is the total combinations multiplied by runs_per_combination.
 *
 * @param config - A validated matrix configuration
 * @returns The total number of test runs that will be executed
 */
export function calculateTotalRuns(config: MatrixConfig): number {
  return calculateTotalCombinations(config) * config.runs_per_combination;
}

/**
 * Generates all possible parameter combinations from a matrix configuration.
 * Each combination is represented as a map of parameter paths to values.
 *
 * @param config - A validated matrix configuration
 * @returns An array of parameter combination objects
 *
 * @example
 * ```typescript
 * const config = {
 *   name: "Test",
 *   base_scenario: "test.yaml",
 *   matrix: [
 *     { parameter: "model", values: ["gpt-4", "claude-3"] },
 *     { parameter: "temp", values: [0.1, 0.5] }
 *   ]
 * };
 *
 * const combinations = generateParameterCombinations(config);
 * // Returns:
 * // [
 * //   { "model": "gpt-4", "temp": 0.1 },
 * //   { "model": "gpt-4", "temp": 0.5 },
 * //   { "model": "claude-3", "temp": 0.1 },
 * //   { "model": "claude-3", "temp": 0.5 }
 * // ]
 * ```
 */
export function generateParameterCombinations(config: MatrixConfig): Record<string, any>[] {
  if (config.matrix.length === 0) {
    return [{}];
  }

  const combinations: Record<string, any>[] = [];

  function generateCombos(axisIndex: number, currentCombo: Record<string, any>): void {
    if (axisIndex >= config.matrix.length) {
      combinations.push({ ...currentCombo });
      return;
    }

    const axis = config.matrix[axisIndex];
    for (const value of axis.values) {
      currentCombo[axis.parameter] = value;
      generateCombos(axisIndex + 1, currentCombo);
    }
  }

  generateCombos(0, {});
  return combinations;
}

/**
 * Validates that a parameter path is well-formed.
 * This is a basic validation that checks for obvious syntax errors.
 *
 * @param parameterPath - The parameter path to validate
 * @returns True if the path appears to be well-formed
 *
 * @example
 * ```typescript
 * isValidParameterPath("character.llm.model")        // true
 * isValidParameterPath("run[0].input")               // true
 * isValidParameterPath("setup.mocks[0].response")    // true
 * isValidParameterPath("")                           // false
 * isValidParameterPath("invalid..path")              // false
 * ```
 */
export function isValidParameterPath(parameterPath: string): boolean {
  if (!parameterPath || parameterPath.length === 0) {
    return false;
  }

  // Check for consecutive dots
  if (parameterPath.includes('..')) {
    return false;
  }

  // Check for leading or trailing dots
  if (parameterPath.startsWith('.') || parameterPath.endsWith('.')) {
    return false;
  }

  // Basic pattern check for valid identifiers and array notation
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d+\])*$/;
  return validPattern.test(parameterPath);
}
