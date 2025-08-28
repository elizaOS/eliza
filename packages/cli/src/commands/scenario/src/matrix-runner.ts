/**
 * Matrix Runner Implementation
 *
 * This module implements the core logic for matrix test execution,
 * including combination generation, execution planning, and result collection.
 */

import { MatrixConfig } from './matrix-schema';
import {
  MatrixCombination,
  MatrixConfigRuntime,
  MatrixAxisRuntime,
  MatrixExecutionContext,
  // CombinationResult, // unused
  // MatrixExecutionResult, // unused
} from './matrix-types';

/**
 * Generates all parameter combinations from a matrix configuration.
 *
 * This is the main function required by ticket #5779. It takes a validated
 * matrix configuration and generates a Cartesian product of all parameter
 * variations, returning an array of MatrixCombination objects.
 *
 * @param config - The validated matrix configuration
 * @returns Array of MatrixCombination objects, each representing a unique set of parameter overrides
 *
 * @example
 * ```typescript
 * const config = {
 *   name: "Test Matrix",
 *   base_scenario: "test.scenario.yaml",
 *   runs_per_combination: 1,
 *   matrix: [
 *     { parameter: "character.llm.model", values: ["gpt-4", "gpt-3.5"] },
 *     { parameter: "run[0].input", values: ["Hello", "Hi"] }
 *   ]
 * };
 *
 * const combinations = generateMatrixCombinations(config);
 * // Returns 4 combinations: all combinations of 2 models × 2 inputs
 * ```
 */
export function generateMatrixCombinations(config: MatrixConfig): MatrixCombination[] {
  // Convert basic config to runtime config for processing
  const runtimeConfig = createRuntimeConfig(config);

  // Generate the Cartesian product of all parameter values
  const combinations = generateCartesianProduct(runtimeConfig.matrix);

  // Convert to MatrixCombination objects with proper metadata
  return combinations.map((parameterSet, index) => {
    const id = generateCombinationId(parameterSet, index);

    return {
      id,
      parameters: parameterSet,
      metadata: {
        combinationIndex: index,
        totalCombinations: combinations.length,
        // runIndex will be set during execution
      },
    };
  });
}

/**
 * Creates a runtime configuration from a basic matrix configuration.
 * Adds computed values and metadata needed for execution.
 *
 * @param config - Basic matrix configuration
 * @returns Runtime configuration with additional metadata
 */
export function createRuntimeConfig(config: MatrixConfig): MatrixConfigRuntime {
  // Calculate total combinations
  const totalCombinations = config.matrix.reduce((total, axis) => total * axis.values.length, 1);
  const totalRuns = totalCombinations * config.runs_per_combination;

  // Create runtime axes with metadata
  const runtimeMatrix: MatrixAxisRuntime[] = config.matrix.map((axis, index) => ({
    parameter: axis.parameter,
    values: axis.values,
    metadata: {
      axisIndex: index,
      valueCount: axis.values.length,
    },
  }));

  return {
    name: config.name,
    description: config.description,
    base_scenario: config.base_scenario,
    runs_per_combination: config.runs_per_combination,
    matrix: runtimeMatrix,
    computed: {
      totalCombinations,
      totalRuns,
      createdAt: new Date(),
    },
  };
}

/**
 * Generates the Cartesian product of matrix axes values.
 *
 * @param axes - Array of matrix axes with their values
 * @returns Array of parameter sets, each representing one combination
 */
function generateCartesianProduct(axes: MatrixAxisRuntime[]): Array<Record<string, any>> {
  if (axes.length === 0) {
    return [];
  }

  if (axes.length === 1) {
    return axes[0].values.map((value) => ({
      [axes[0].parameter]: value,
    }));
  }

  // Recursive Cartesian product generation
  const [firstAxis, ...remainingAxes] = axes;
  const remainingProduct = generateCartesianProduct(remainingAxes);

  const result: Array<Record<string, any>> = [];

  for (const value of firstAxis.values) {
    for (const combination of remainingProduct) {
      result.push({
        [firstAxis.parameter]: value,
        ...combination,
      });
    }
  }

  return result;
}

/**
 * Generates a unique identifier for a parameter combination.
 *
 * @param parameters - The parameter set for this combination
 * @param index - The index of this combination in the matrix
 * @returns A unique string identifier
 */
function generateCombinationId(parameters: Record<string, any>, index: number): string {
  // Create a stable hash of the parameters for uniqueness
  const parameterKeys = Object.keys(parameters).sort();
  const parameterHash = parameterKeys
    .map((key) => `${key}=${JSON.stringify(parameters[key])}`)
    .join('&');

  // Use index as primary identifier with parameter hash for verification
  return `combo-${index.toString().padStart(3, '0')}-${hashString(parameterHash).slice(0, 8)}`;
}

/**
 * Simple string hashing function for generating combination IDs.
 *
 * @param str - String to hash
 * @returns Hexadecimal hash string
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Creates an execution context for a matrix run.
 *
 * @param config - Matrix configuration
 * @param combinations - Generated combinations to execute
 * @param settings - Execution settings
 * @returns Execution context for tracking matrix execution
 */
export function createExecutionContext(
  config: MatrixConfig,
  combinations: MatrixCombination[],
  settings: {
    parallelism: number;
    dryRun: boolean;
    filter?: string;
    verbose: boolean;
  }
): MatrixExecutionContext {
  const runtimeConfig = createRuntimeConfig(config);

  return {
    config: runtimeConfig,
    combinations,
    settings,
    state: {
      phase: 'initializing',
      completedCombinations: 0,
      failedCombinations: 0,
    },
  };
}

/**
 * Applies filter to combinations based on a pattern.
 *
 * @param combinations - All combinations
 * @param filter - Filter pattern to match against
 * @returns Filtered combinations
 */
export function filterCombinations(
  combinations: MatrixCombination[],
  filter: string
): MatrixCombination[] {
  return combinations.filter((combination) => {
    // Simple string matching - can be enhanced with regex or more sophisticated filtering
    const combinationStr = JSON.stringify(combination.parameters);
    return combinationStr.toLowerCase().includes(filter.toLowerCase());
  });
}

/**
 * Validates that all combinations have valid parameter paths.
 * This is a placeholder for integration with the parameter override system.
 *
 * @param combinations - Combinations to validate
 * @param baseScenario - Base scenario object to validate against
 * @returns Validation result with any invalid combinations
 */
export function validateCombinations(
  combinations: MatrixCombination[],
  _baseScenario: any
): { valid: boolean; invalidCombinations: string[]; errors: string[] } {
  // This will be fully implemented when integrated with the parameter override system
  // For now, we'll do basic validation

  const invalidCombinations: string[] = [];
  const errors: string[] = [];

  for (const combination of combinations) {
    // Basic validation - check that parameters object is valid
    if (!combination.parameters || typeof combination.parameters !== 'object') {
      invalidCombinations.push(combination.id);
      errors.push(`Combination ${combination.id} has invalid parameters object`);
      continue;
    }

    // Check that all parameter values are serializable
    try {
      JSON.stringify(combination.parameters);
    } catch (error) {
      invalidCombinations.push(combination.id);
      errors.push(`Combination ${combination.id} has non-serializable parameter values`);
    }
  }

  return {
    valid: invalidCombinations.length === 0,
    invalidCombinations,
    errors,
  };
}

/**
 * Calculates execution statistics for planning purposes.
 *
 * @param combinations - Combinations to execute
 * @param runsPerCombination - Number of runs per combination
 * @returns Execution statistics
 */
export function calculateExecutionStats(
  combinations: MatrixCombination[],
  runsPerCombination: number
): {
  totalCombinations: number;
  totalRuns: number;
  estimatedDuration: {
    optimistic: number; // seconds
    realistic: number; // seconds
    pessimistic: number; // seconds
  };
} {
  const totalCombinations = combinations.length;
  const totalRuns = totalCombinations * runsPerCombination;

  // Rough estimates based on typical scenario execution times
  const averageScenarioTime = 30; // seconds per scenario run
  const setupOverhead = 5; // seconds per combination for setup

  const optimistic = totalRuns * averageScenarioTime * 0.5 + totalCombinations * setupOverhead;
  const realistic = totalRuns * averageScenarioTime + totalCombinations * setupOverhead;
  const pessimistic = totalRuns * averageScenarioTime * 2 + totalCombinations * setupOverhead;

  return {
    totalCombinations,
    totalRuns,
    estimatedDuration: {
      optimistic: Math.round(optimistic),
      realistic: Math.round(realistic),
      pessimistic: Math.round(pessimistic),
    },
  };
}

/**
 * Formats execution time in a human-readable format.
 *
 * @param seconds - Time in seconds
 * @returns Formatted time string
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}
