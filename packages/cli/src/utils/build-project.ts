import { promises as fs } from "node:fs";
import { logger } from "@elizaos/core";
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
    // list the files in the directory
    const files = await fs.readdir(cwd);
    console.log("files");
    console.trace();
    console.log(files);
    logger.info(`Building ${isPlugin ? "plugin" : "project"}...`);
    await runBunCommand(["install"], cwd);
    console.log("installed");
    await runBunCommand(["run", "build"], cwd);
    console.log("built");
    logger.success(`${isPlugin ? "Plugin" : "Project"} built successfully!`);
    return true;
  } catch (error) {
    logger.error(`Failed to build ${isPlugin ? "plugin" : "project"}: ${JSON.stringify(error)}`);
    return false;
  }
} 