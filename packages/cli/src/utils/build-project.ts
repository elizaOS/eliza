import { runBunCommand } from "./run-bun";
import { logger } from "@elizaos/core";

/**
 * Builds a project or plugin by running the build script.
 * 
 * @param {string} cwd - The directory where the build command will be executed
 * @param {boolean} [isPlugin=false] - Whether the target is a plugin
 * @returns {Promise<boolean>} - Whether the build was successful
 */
export async function buildProject(
  cwd: string,
  isPlugin: boolean = false
): Promise<boolean> {
  try {
    logger.info(`Building ${isPlugin ? "plugin" : "project"}...`);
    await runBunCommand(["run", "build"], cwd);
    logger.success(`${isPlugin ? "Plugin" : "Project"} built successfully!`);
    return true;
  } catch (error) {
    logger.error(`Failed to build ${isPlugin ? "plugin" : "project"}: ${error.message}`);
    return false;
  }
} 