/**
 * RL Configuration Logger
 *
 * Logs RL model configuration and availability on server startup.
 * Used for diagnostics and verification during deployment.
 */

import { logger } from "@feed/shared";
import { isRLModelAvailable, logRLModelConfig } from "./RLModelConfig";

/**
 * Log RL model configuration and verify setup
 *
 * Call this on server startup to display configuration details
 * and verify that the RL training system is properly configured.
 */
export async function logRLConfigOnStartup(): Promise<void> {
  logger.info(
    "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    undefined,
    "logRLConfig",
  );
  logger.info("RL Training System Configuration", undefined, "logRLConfig");
  logger.info(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n",
    undefined,
    "logRLConfig",
  );

  // Log RL configuration
  logRLModelConfig();

  // Check if RL models are available
  const available = isRLModelAvailable();

  if (available) {
    logger.info("RL Model system available", undefined, "logRLConfig");
  } else {
    logger.info(
      "RL models not available - using base model",
      undefined,
      "logRLConfig",
    );
  }

  logger.info(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n",
    undefined,
    "logRLConfig",
  );
}
