import { logger } from "@elizaos/core";
import { existsSync } from "node:fs";
import path from "node:path";
import { runBunCommand } from "./run-bun";
/**
 * Builds a project or plugin by running the build script.
 * 
 * @param {string} cwd - The directory where the build command will be executed
 * @param {boolean} [isPlugin=false] - Whether the target is a plugin
 * @returns {Promise<boolean>} - Whether the build was successful
 */
export async function buildProject(
  cwd: string,
  isPlugin = false
): Promise<boolean> {
  try {
    logger.info(`Building ${isPlugin ? "plugin" : "project"}...`);
    
    // Only run install if node_modules doesn't exist
    const nodeModulesPath = path.join(cwd, "node_modules");
    if (!existsSync(nodeModulesPath)) {
      logger.info("No node_modules folder found, running install...");
      await runBunCommand(["install"], cwd);
    } else {
      logger.info("Using existing node_modules folder");
    }
    
    await runBunCommand(["run", "build"], cwd);
    logger.success(`${isPlugin ? "Plugin" : "Project"} built successfully!`);
    return true;
  } catch (error) {
    logger.error(`Failed to build ${isPlugin ? "plugin" : "project"}: ${JSON.stringify(error)}`);
    return false;
  }
} 