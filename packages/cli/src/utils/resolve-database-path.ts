import { execaCommand } from "execa";
import fs from "node:fs";
import path from "node:path";
import prompts from "prompts";
import { getConfig } from "./get-config";
import { logger } from "./logger";

// Helper function to search for db.sqlite using available shell commands.
async function searchDatabaseFile(): Promise<string> {
  const commands = ["find . -name db.sqlite", "dir /s /b db.sqlite"];
  for (const cmd of commands) {
    try {
      const { stdout } = await execaCommand(cmd);
      const result = stdout.trim();
      if (result) {
        return result;
      }
    } catch (error) {
      logger.error(`Error executing command "${cmd}":`, error);
    }
  }
  return "";
}

export async function resolveDatabasePath(options?: { requiredConfig?: boolean }): Promise<string> {
  const { requiredConfig = true } = options || {};
  const cwd = process.cwd();
  const config = await getConfig(cwd);

  // If a project config exists, use its database path.
  if (config) {
    return (config.database.config as { path: string }).path;
  }

  // For commands that require an initialized project, exit early.
  if (requiredConfig) {
    logger.error("No project.json found. Please run init first.");
    process.exit(1);
  }

  // Otherwise, try to locate db.sqlite using shell commands.
  let dbPath = await searchDatabaseFile();

  // If path is resolved, log it.
  if (dbPath) {
    logger.info(`Resolved database path: ${dbPath}`);
  }

  // If no database file was found, prompt the user to provide one.
  if (!dbPath) {
    logger.info("No db.sqlite found. Please provide a path to create a database.");
    const dbInput = await prompts({
      type: "text",
      name: "value",
      message: "Enter path to create a database:",
    });

    // check if path was provided
    if (!dbInput.value) {
      logger.error("No path provided. Please provide a path to create a database.");
      process.exit(1);
    }

    // check if the path is valid
    if (!fs.existsSync(dbInput.value)) {
      logger.error("Invalid path. Please provide a valid path or directory.");
      process.exit(1);
    }
    
    // Use the input directly if it contains ".sqlite", otherwise append it.
    dbPath = dbInput.value.includes(".sqlite") ? dbInput.value : path.join(dbInput.value, "db.sqlite");

    // Create the file if it does not exist.
    if (!fs.existsSync(dbPath)) {
      await fs.promises.writeFile(dbPath, "");
      logger.success(`Created db.sqlite in ${dbInput.value}`);
    }
  }

  return dbPath;
} 