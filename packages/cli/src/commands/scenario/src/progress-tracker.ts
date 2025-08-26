/**
 * Progress Tracking System for Matrix Testing
 *
 * This module provides real-time progress tracking, ETA calculation, and
 * detailed progress reporting for matrix execution. It tracks both individual
 * run progress and overall matrix completion.
 *
 * Required by ticket #5782 - Acceptance Criterion 4.
 */

/**
 * Types of progress events that can be emitted.
 */
export type ProgressEventType =
  | 'MATRIX_STARTED'
  | 'COMBINATION_STARTED'
  | 'RUN_STARTED'
  | 'PROGRESS_UPDATE'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED'
  | 'TIMEOUT'
  | 'COMBINATION_COMPLETED'
  | 'MATRIX_COMPLETED'
  | 'RESOURCE_WARNING'
  | 'ERROR';

/**
 * Callback function type for progress updates.
 */
export type ProgressCallback = (message: string, eventType: ProgressEventType, data?: any) => void;

/**
 * Overall progress information for the matrix execution.
 */
export interface MatrixProgress {
  /** Total number of combinations in the matrix */
  totalCombinations: number;
  /** Total number of runs across all combinations */
  totalRuns: number;
  /** Number of combinations completed */
  completedCombinations: number;
  /** Number of runs completed */
  completedRuns: number;
  /** Number of runs that failed */
  failedRuns: number;
  /** Number of runs that succeeded */
  successfulRuns: number;
  /** Current combination being executed (0-based) */
  currentCombination: number;
  /** Overall progress as a percentage (0-1) */
  overallProgress: number;
  /** Average duration per run in milliseconds */
  averageRunDuration: number;
  /** Estimated time remaining in milliseconds */
  estimatedTimeRemaining: number | null;
  /** When the matrix execution started */
  startTime: Date;
  /** When the matrix execution will complete (estimated) */
  estimatedCompletionTime: Date | null;
}

/**
 * Progress information for a specific combination.
 */
export interface CombinationProgress {
  /** Unique identifier for the combination */
  combinationId: string;
  /** Parameters for this combination */
  parameters: Record<string, any>;
  /** Total runs for this combination */
  totalRuns: number;
  /** Completed runs for this combination */
  completedRuns: number;
  /** Successful runs for this combination */
  successfulRuns: number;
  /** Failed runs for this combination */
  failedRuns: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Average duration for runs in this combination */
  averageDuration: number;
  /** When this combination started */
  startTime: Date | null;
  /** When this combination completed */
  completionTime: Date | null;
}

/**
 * Information about an individual run.
 */
export interface RunProgress {
  /** Unique identifier for the run */
  runId: string;
  /** Combination this run belongs to */
  combinationId: string;
  /** Parameters for this run */
  parameters: Record<string, any>;
  /** When the run started */
  startTime: Date;
  /** When the run completed */
  completionTime: Date | null;
  /** Current progress within the run (0-1) */
  progress: number;
  /** Current status message */
  status: string;
  /** Whether the run completed successfully */
  success: boolean | null;
  /** Error message if the run failed */
  error: string | null;
  /** Duration in milliseconds */
  duration: number;
}

/**
 * Configuration for the progress tracker.
 */
export interface ProgressTrackerConfig {
  /** Total number of combinations */
  totalCombinations: number;
  /** Number of runs per combination */
  runsPerCombination: number;
  /** Callback for progress updates */
  onProgress?: ProgressCallback;
  /** Callback when a combination completes */
  onCombinationComplete?: (progress: CombinationProgress) => void;
  /** Whether to show detailed parameter information */
  showParameters?: boolean;
  /** Whether to calculate ETA */
  calculateETA?: boolean;
}

/**
 * Main progress tracking class for matrix execution.
 */
export class ProgressTracker {
  private config: ProgressTrackerConfig;
  private startTime: Date;
  private combinations = new Map<string, CombinationProgress>();
  private runs = new Map<string, RunProgress>();
  private runDurations: number[] = [];
  private currentCombinationIndex = 0;

  constructor(config: ProgressTrackerConfig) {
    this.config = {
      showParameters: true,
      calculateETA: true,
      ...config,
    };
    this.startTime = new Date();
  }

  /**
   * Starts tracking a new run.
   */
  startRun(runId: string, combinationId: string, parameters: Record<string, any>): void {
    // Initialize combination if not exists
    if (!this.combinations.has(combinationId)) {
      this.combinations.set(combinationId, {
        combinationId,
        parameters,
        totalRuns: this.config.runsPerCombination,
        completedRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        successRate: 0,
        averageDuration: 0,
        startTime: new Date(),
        completionTime: null,
      });
    }

    // Create run progress entry
    const runProgress: RunProgress = {
      runId,
      combinationId,
      parameters,
      startTime: new Date(),
      completionTime: null,
      progress: 0,
      status: 'Starting...',
      success: null,
      error: null,
      duration: 0,
    };

    this.runs.set(runId, runProgress);

    // Calculate run position
    const completedRuns = this.getOverallProgress().completedRuns;
    const totalRuns = this.config.totalCombinations * this.config.runsPerCombination;
    const runNumber = completedRuns + 1;

    // Get combination info for the message
    const combination = this.combinations.get(combinationId)!;
    const combIndex = Array.from(this.combinations.keys()).indexOf(combinationId) + 1;
    const runInCombination = combination.completedRuns + 1;

    // Format parameter information
    let parameterInfo = '';
    if (this.config.showParameters && Object.keys(parameters).length > 0) {
      const paramPairs = Object.entries(parameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
      parameterInfo = ` (${paramPairs})`;
    }

    const message = `Executing run ${runNumber} of ${totalRuns} (Combination ${combIndex}/${this.config.totalCombinations}, Run ${runInCombination}/${this.config.runsPerCombination})${parameterInfo}`;

    this.emitProgress(message, 'RUN_STARTED', {
      runId,
      combinationId,
      parameters,
      runNumber,
      totalRuns,
    });
  }

  /**
   * Updates progress for a currently running scenario.
   */
  updateRunProgress(runId: string, progress: number, status: string): void {
    const run = this.runs.get(runId);
    if (!run) return;

    run.progress = progress;
    run.status = status;

    const percentage = Math.round(progress * 100);
    const message = `Run ${runId}: ${percentage}% - ${status}`;

    this.emitProgress(message, 'PROGRESS_UPDATE', {
      runId,
      progress,
      status,
    });
  }

  /**
   * Marks a run as completed successfully.
   */
  completeRun(runId: string, success: boolean, duration: number, error?: string): void {
    const run = this.runs.get(runId);
    if (!run) return;

    run.completionTime = new Date();
    run.success = success;
    run.duration = duration;
    run.error = error || null;
    run.progress = 1;

    // Update combination statistics
    const combination = this.combinations.get(run.combinationId)!;
    combination.completedRuns++;

    if (success) {
      combination.successfulRuns++;
    } else {
      combination.failedRuns++;
    }

    combination.successRate = combination.successfulRuns / combination.completedRuns;

    // Update duration tracking
    this.runDurations.push(duration);
    if (this.runDurations.length > 100) {
      this.runDurations = this.runDurations.slice(-100); // Keep last 100 for rolling average
    }

    // Calculate average duration for combination
    const combinationRuns = Array.from(this.runs.values()).filter(
      (r) => r.combinationId === run.combinationId && r.duration > 0
    );
    combination.averageDuration =
      combinationRuns.reduce((sum, r) => sum + r.duration, 0) / combinationRuns.length;

    // Emit completion message
    const completedRuns = this.getOverallProgress().completedRuns;
    // const totalRuns = this.config.totalCombinations * this.config.runsPerCombination; // unused

    if (success) {
      const message = `Run ${completedRuns} completed successfully in ${this.formatDuration(duration)}`;
      this.emitProgress(message, 'RUN_COMPLETED', { runId, duration, success: true });
    } else {
      const message = `Run ${completedRuns} failed: ${error || 'Unknown error'}`;
      this.emitProgress(message, 'RUN_FAILED', { runId, duration, success: false, error });
    }

    // Emit ETA update if we have enough data
    if (this.config.calculateETA && this.runDurations.length >= 3) {
      this.emitETAUpdate();
    }

    // Check if combination is complete
    if (combination.completedRuns === combination.totalRuns) {
      this.completeCombination(run.combinationId);
    }
  }

  /**
   * Marks a run as timed out.
   */
  timeoutRun(runId: string, timeoutMs: number): void {
    this.completeRun(runId, false, timeoutMs, `Timeout after ${timeoutMs / 1000} seconds`);

    const message = `Run ${runId} timed out after ${timeoutMs / 1000} seconds`;
    this.emitProgress(message, 'TIMEOUT', { runId, timeoutMs });
  }

  /**
   * Marks a combination as completed.
   */
  completeCombination(combinationId: string): void {
    const combination = this.combinations.get(combinationId);
    if (!combination) return;

    combination.completionTime = new Date();

    const combIndex = Array.from(this.combinations.keys()).indexOf(combinationId) + 1;
    const successRate = Math.round(combination.successRate * 100);
    const avgDuration = this.formatDuration(combination.averageDuration);

    const message = `Combination ${combIndex}/${this.config.totalCombinations} completed (${successRate}% success rate, avg: ${avgDuration})`;
    this.emitProgress(message, 'COMBINATION_COMPLETED', combination);

    // Notify combination completion callback
    if (this.config.onCombinationComplete) {
      this.config.onCombinationComplete(combination);
    }
  }

  /**
   * Reports a resource warning.
   */
  reportResourceWarning(resource: string, usage: number, message: string): void {
    const warningMessage = `Resource warning: ${resource} at ${usage}% - ${message}`;
    this.emitProgress(warningMessage, 'RESOURCE_WARNING', { resource, usage, message });
  }

  /**
   * Gets overall progress information.
   */
  getOverallProgress(): MatrixProgress {
    const completedRuns = Array.from(this.runs.values()).filter((r) => r.completionTime).length;
    const totalRuns = this.config.totalCombinations * this.config.runsPerCombination;
    const failedRuns = Array.from(this.runs.values()).filter((r) => r.success === false).length;
    const successfulRuns = Array.from(this.runs.values()).filter((r) => r.success === true).length;
    const completedCombinations = Array.from(this.combinations.values()).filter(
      (c) => c.completionTime
    ).length;

    const averageRunDuration =
      this.runDurations.length > 0
        ? this.runDurations.reduce((sum, duration) => sum + duration, 0) / this.runDurations.length
        : 0;

    const remainingRuns = totalRuns - completedRuns;
    const estimatedTimeRemaining =
      remainingRuns > 0 && averageRunDuration > 0 ? remainingRuns * averageRunDuration : null;

    const estimatedCompletionTime = estimatedTimeRemaining
      ? new Date(Date.now() + estimatedTimeRemaining)
      : null;

    return {
      totalCombinations: this.config.totalCombinations,
      totalRuns,
      completedCombinations,
      completedRuns,
      failedRuns,
      successfulRuns,
      currentCombination: this.currentCombinationIndex,
      overallProgress: totalRuns > 0 ? completedRuns / totalRuns : 0,
      averageRunDuration,
      estimatedTimeRemaining,
      startTime: this.startTime,
      estimatedCompletionTime,
    };
  }

  /**
   * Gets progress information for a specific combination.
   */
  getCombinationProgress(combinationId: string): CombinationProgress | undefined {
    return this.combinations.get(combinationId);
  }

  /**
   * Exports all progress data for analysis or reporting.
   */
  exportProgressData(): {
    overallProgress: MatrixProgress;
    combinations: Map<string, CombinationProgress>;
    runs: Map<string, RunProgress>;
    startTime: Date;
    statistics: {
      averageRunDuration: number;
      successRate: number;
      failureRate: number;
      totalDuration: number;
    };
  } {
    const overall = this.getOverallProgress();
    const totalDuration = Date.now() - this.startTime.getTime();

    return {
      overallProgress: overall,
      combinations: this.combinations,
      runs: this.runs,
      startTime: this.startTime,
      statistics: {
        averageRunDuration: overall.averageRunDuration,
        successRate: overall.completedRuns > 0 ? overall.successfulRuns / overall.completedRuns : 0,
        failureRate: overall.completedRuns > 0 ? overall.failedRuns / overall.completedRuns : 0,
        totalDuration,
      },
    };
  }

  /**
   * Emits ETA update based on current progress.
   */
  private emitETAUpdate(): void {
    const progress = this.getOverallProgress();

    if (progress.estimatedTimeRemaining) {
      const eta = this.formatDuration(progress.estimatedTimeRemaining);
      const completionTime = progress.estimatedCompletionTime?.toLocaleTimeString() || 'unknown';

      const message = `ETA: ${eta} (completion: ${completionTime})`;
      this.emitProgress(message, 'PROGRESS_UPDATE', {
        estimatedTimeRemaining: progress.estimatedTimeRemaining,
        estimatedCompletionTime: progress.estimatedCompletionTime,
      });
    }
  }

  /**
   * Emits a progress message to the callback.
   */
  private emitProgress(message: string, eventType: ProgressEventType, data?: any): void {
    if (this.config.onProgress) {
      this.config.onProgress(message, eventType, data);
    }
  }

  /**
   * Formats a duration in milliseconds to human-readable format.
   */
  private formatDuration(milliseconds: number): string {
    if (milliseconds < 1000) {
      return `${Math.round(milliseconds)}ms`;
    }

    const seconds = Math.floor(milliseconds / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
      return `${minutes}m ${remainingSeconds}s`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
}

/**
 * Creates a new progress tracker with the specified configuration.
 */
export function createProgressTracker(config: ProgressTrackerConfig): ProgressTracker {
  return new ProgressTracker(config);
}
