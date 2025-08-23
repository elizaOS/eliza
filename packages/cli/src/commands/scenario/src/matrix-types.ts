/**
 * Types for the Matrix Testing System
 *
 * These types define the data structures used throughout the matrix testing
 * system for representing combinations, metadata, and execution states.
 */

/**
 * Represents a single parameter combination in a matrix test.
 * Each combination represents a unique set of parameter overrides to apply
 * to the base scenario.
 */
export interface MatrixCombination {
  /** Unique identifier for this combination */
  id: string;

  /** The set of parameter overrides to apply, mapping parameter paths to values */
  parameters: Record<string, any>;

  /** Metadata about this combination's position in the matrix */
  metadata: {
    /** Zero-based index of this combination in the full matrix */
    combinationIndex: number;

    /** Total number of combinations in the matrix */
    totalCombinations: number;

    /** Run index within this combination (set during execution) */
    runIndex?: number;
  };
}

/**
 * Configuration for a matrix axis, defining one dimension of variation.
 * This extends the basic MatrixAxis from the schema with runtime metadata.
 */
export interface MatrixAxisRuntime {
  /** The parameter path to override (e.g., "character.llm.model") */
  parameter: string;

  /** Array of values to test for this parameter */
  values: any[];

  /** Runtime metadata about this axis */
  metadata: {
    /** Index of this axis in the matrix */
    axisIndex: number;

    /** Total number of values for this axis */
    valueCount: number;
  };
}

/**
 * Runtime matrix configuration with additional metadata.
 * This extends the basic MatrixConfig with computed values and runtime state.
 */
export interface MatrixConfigRuntime {
  /** Matrix configuration name */
  name: string;

  /** Optional description */
  description?: string;

  /** Path to the base scenario file */
  base_scenario: string;

  /** Number of times to run each combination */
  runs_per_combination: number;

  /** Array of matrix axes with runtime metadata */
  matrix: MatrixAxisRuntime[];

  /** Computed totals */
  computed: {
    /** Total number of unique parameter combinations */
    totalCombinations: number;

    /** Total number of test runs (combinations × runs_per_combination) */
    totalRuns: number;

    /** Timestamp when this runtime config was created */
    createdAt: Date;
  };
}

/**
 * Execution context for a matrix run.
 * Tracks the current state of matrix execution.
 */
export interface MatrixExecutionContext {
  /** The matrix configuration being executed */
  config: MatrixConfigRuntime;

  /** All combinations to execute */
  combinations: MatrixCombination[];

  /** Execution settings */
  settings: {
    /** Maximum number of parallel executions */
    parallelism: number;

    /** Whether this is a dry run */
    dryRun: boolean;

    /** Filter pattern for combinations */
    filter?: string;

    /** Verbose output enabled */
    verbose: boolean;
  };

  /** Execution state */
  state: {
    /** Current execution phase */
    phase: 'initializing' | 'validating' | 'executing' | 'completed' | 'failed';

    /** Number of combinations completed */
    completedCombinations: number;

    /** Number of combinations failed */
    failedCombinations: number;

    /** Start time of execution */
    startTime?: Date;

    /** End time of execution */
    endTime?: Date;
  };
}

/**
 * Result of a single combination execution.
 */
export interface CombinationResult {
  /** The combination that was executed */
  combination: MatrixCombination;

  /** Whether the combination passed all evaluations */
  success: boolean;

  /** Execution duration in milliseconds */
  duration: number;

  /** Detailed results for each run of this combination */
  runs: Array<{
    /** Run index within this combination */
    runIndex: number;

    /** Whether this run succeeded */
    success: boolean;

    /** Duration of this run in milliseconds */
    duration: number;

    /** Error message if the run failed */
    error?: string;

    /** Detailed evaluation results */
    evaluations?: any[];
  }>;

  /** Error message if the combination failed */
  error?: string;

  /** Timestamp when this combination was executed */
  executedAt: Date;
}

/**
 * Complete results of a matrix execution.
 */
export interface MatrixExecutionResult {
  /** The execution context */
  context: MatrixExecutionContext;

  /** Results for each combination */
  results: CombinationResult[];

  /** Summary statistics */
  summary: {
    /** Total combinations executed */
    totalCombinations: number;

    /** Number of combinations that passed */
    successfulCombinations: number;

    /** Number of combinations that failed */
    failedCombinations: number;

    /** Success rate as a percentage */
    successRate: number;

    /** Total execution time in milliseconds */
    totalDuration: number;

    /** Average time per combination in milliseconds */
    averageCombinationDuration: number;
  };

  /** Timestamp when execution completed */
  completedAt: Date;
}
