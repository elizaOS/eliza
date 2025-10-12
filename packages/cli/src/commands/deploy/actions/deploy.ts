/**
 * Deploy Action - Main deployment logic
 */

import { logger } from "@elizaos/core";
import type { DeployOptions, DeploymentResult } from "../types";
import { deployWithBootstrapper } from "./deploy-bootstrapper";

/**
 * Main deployment handler - uses bootstrapper architecture
 */
export async function deployProject(
  options: DeployOptions,
): Promise<DeploymentResult> {
  try {
    logger.info("🚀 Starting ElizaOS deployment with bootstrapper architecture");
    return await deployWithBootstrapper(options);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("Deployment error:", errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  }
}