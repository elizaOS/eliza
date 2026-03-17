/**
 * Training Package Initialization
 *
 * This module sets up all dependencies required by the training package.
 * Import this before using TrajectoryGenerator or other training services.
 *
 * Usage:
 *   import { configureTrainingDependencies, initializeTrainingPackage } from '@elizaos/training';
 *   configureTrainingDependencies({ ... });
 *   await initializeTrainingPackage();
 */

import { areDependenciesConfigured } from "./dependencies";
import { logger } from "./utils/logger";

let initialized = false;

/**
 * Initialize training package.
 *
 * External dependencies must be configured first via `configureTrainingDependencies`.
 */
export async function initializeTrainingPackage(): Promise<void> {
  if (initialized) {
    logger.debug("Training package already initialized", {}, "TrainingInit");
    return;
  }

  logger.info("Initializing training package...", {}, "TrainingInit");

  if (!areDependenciesConfigured()) {
    throw new Error(
      "Training dependencies not configured. Call configureTrainingDependencies() first.",
    );
  }

  initialized = true;
  logger.info("Training package initialized successfully", {}, "TrainingInit");
}

/**
 * Check if training package is initialized
 */
export function isTrainingInitialized(): boolean {
  return initialized;
}

/**
 * Reset initialization state (for testing)
 */
export function resetTrainingInitialization(): void {
  initialized = false;
}
