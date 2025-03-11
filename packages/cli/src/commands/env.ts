import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleError } from "@/src/utils/handle-error";
import { logger } from "@elizaos/core";
import chalk from "chalk";
import { Command } from "commander";
import dotenv from "dotenv";
import prompts from "prompts";
import { rimraf } from "rimraf";

/**
 * Get the path to the global .env file in the user's home directory
 * @returns The path to the global .env file
 */
function getGlobalEnvPath(): string {
  const homeDir = os.homedir();
  const elizaDir = path.join(homeDir, ".eliza");
  return path.join(elizaDir, ".env");
}

/**
 * Get the path to the local .env file in the current directory
 * @returns The path to the local .env file or null if not found
 */
function getLocalEnvPath(): string | null {
  const localEnvPath = path.join(process.cwd(), ".env");
  return existsSync(localEnvPath) ? localEnvPath : null;
}

/**
 * Parse an .env file and return the key-value pairs
 * @param filePath Path to the .env file
 * @returns Object containing the key-value pairs
 */
async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    if (!existsSync(filePath)) {
      return {};
    }
    
    const content = await fs.readFile(filePath, "utf-8");
    return dotenv.parse(content);
  } catch (error) {
    logger.error(`Error parsing .env file at ${filePath}: ${error.message}`);
    return {};
  }
}

/**
 * Write key-value pairs to an .env file
 * @param filePath Path to the .env file
 * @param envVars Object containing the key-value pairs
 */
async function writeEnvFile(filePath: string, envVars: Record<string, string>): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }
    
    const content = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    
    await fs.writeFile(filePath, content);
    logger.success(`Environment variables updated at ${filePath}`);
  } catch (error) {
    logger.error(`Error writing .env file at ${filePath}: ${error.message}`);
  }
}

/**
 * List all environment variables from both global and local .env files
 */
async function listEnvVars(): Promise<void> {
  const globalEnvPath = getGlobalEnvPath();
  const localEnvPath = getLocalEnvPath();
  
  const globalEnvVars = await parseEnvFile(globalEnvPath);
  const localEnvVars = localEnvPath ? await parseEnvFile(localEnvPath) : {};
  
  logger.info(chalk.bold("\nGlobal environment variables (.eliza/.env):"));
  if (Object.keys(globalEnvVars).length === 0) {
    logger.info("  No global environment variables set");
  } else {
    Object.entries(globalEnvVars).forEach(([key, value]) => {
      logger.info(`  ${chalk.green(key)}: ${maskedValue(value)}`);
    });
  }
  
  if (localEnvPath) {
    logger.info(chalk.bold("\nLocal environment variables (.env):"));
    if (Object.keys(localEnvVars).length === 0) {
      logger.info("  No local environment variables set");
    } else {
      Object.entries(localEnvVars).forEach(([key, value]) => {
        logger.info(`  ${chalk.green(key)}: ${maskedValue(value)}`);
      });
    }
  } else {
    logger.info(chalk.bold("\nNo local .env file found in the current directory"));
  }
  
  logger.info("\n");
}

/**
 * Mask sensitive values in environment variables
 * @param value The value to mask
 * @returns The masked value
 */
function maskedValue(value: string): string {
  if (!value) return "";
  
  // If the value looks like a token/API key (longer than 20 chars, no spaces), mask it
  if (value.length > 20 && !value.includes(" ")) {
    return `${value.substring(0, 4)}...${value.substring(value.length - 4)}`;
  }
  
  return value;
}

/**
 * Edit environment variables
 * @param scope Whether to edit global or local environment variables
 */
async function editEnvVars(scope: "global" | "local"): Promise<void> {
  const envPath = scope === "global" ? getGlobalEnvPath() : getLocalEnvPath();
  
  if (scope === "local" && !envPath) {
    const { createLocal } = await prompts({
      type: "confirm",
      name: "createLocal",
      message: "No local .env file found. Create one?",
      initial: true,
    });
    
    if (!createLocal) {
      return;
    }
    
    // Create an empty local .env file
    await writeEnvFile(path.join(process.cwd(), ".env"), {});
    logger.success("Created empty local .env file");
    return;
  }
  
  const envVars = await parseEnvFile(envPath);
  
  // List current variables first
  logger.info(chalk.bold(`\nCurrent ${scope} environment variables:`));
  if (Object.keys(envVars).length === 0) {
    logger.info(`  No ${scope} environment variables set`);
    
    // If no variables exist, offer to add new ones
    const { addNew } = await prompts({
      type: "confirm",
      name: "addNew",
      message: "Would you like to add a new environment variable?",
      initial: true,
    });
    
    if (addNew) {
      await addNewVariable(envPath, envVars);
    }
    
    return;
  }
  
  // Keep looping until the user chooses to exit
  let exit = false;
  while (!exit) {
    // Create menu choices from the environment variables
    const entries = Object.entries(envVars);
    const choices = [
      ...entries.map(([key, value]) => ({
        title: `${key}: ${maskedValue(value)}`,
        value: key,
      })),
      { title: "Add new variable", value: "add_new" },
      { title: "Exit", value: "exit" },
    ];
    
    // Prompt user to select a variable or action
    const { selection } = await prompts({
      type: "select",
      name: "selection",
      message: "Select a variable to edit or an action:",
      choices,
    });
    
    if (!selection || selection === "exit") {
      exit = true;
      continue;
    }
    
    if (selection === "add_new") {
      await addNewVariable(envPath, envVars);
      continue;
    }
    
    // User selected a variable, prompt for action
    const { action } = await prompts({
      type: "select",
      name: "action",
      message: `What would you like to do with ${selection}?`,
      choices: [
        { title: "Edit", value: "edit" },
        { title: "Delete", value: "delete" },
        { title: "Back", value: "back" },
      ],
    });
    
    if (!action || action === "back") {
      continue;
    }
    
    if (action === "edit") {
      const { value } = await prompts({
        type: "text",
        name: "value",
        message: `Enter the new value for ${selection}:`,
        initial: envVars[selection],
      });
      
      if (value !== undefined) {
        envVars[selection] = value;
        await writeEnvFile(envPath, envVars);
        logger.success(`Updated ${scope} environment variable: ${selection}`);
      }
    } else if (action === "delete") {
      const { confirm } = await prompts({
        type: "confirm",
        name: "confirm",
        message: `Are you sure you want to delete ${selection}?`,
        initial: false,
      });
      
      if (confirm) {
        delete envVars[selection];
        await writeEnvFile(envPath, envVars);
        logger.success(`Removed ${scope} environment variable: ${selection}`);
      }
    }
  }
}

/**
 * Helper function to add a new environment variable
 * @param envPath Path to the .env file
 * @param envVars Current environment variables
 */
async function addNewVariable(envPath: string, envVars: Record<string, string>): Promise<void> {
  const { key } = await prompts({
    type: "text",
    name: "key",
    message: "Enter the variable name:",
    validate: value => value.trim() !== "" ? true : "Variable name cannot be empty",
  });
  
  if (!key) return;
  
  const { value } = await prompts({
    type: "text",
    name: "value",
    message: `Enter the value for ${key}:`,
  });
  
  if (value !== undefined) {
    envVars[key] = value;
    await writeEnvFile(envPath, envVars);
    logger.success(`Added environment variable: ${key}`);
  }
}

/**
 * Reset all environment variables and wipe the cache folder
 */
async function resetEnv(): Promise<void> {
  const { confirm } = await prompts({
    type: "confirm",
    name: "confirm",
    message: "This will delete all environment variables and wipe the cache folder. Are you sure?",
    initial: false,
  });
  
  if (!confirm) {
    logger.info("Reset canceled");
    return;
  }
  
  // Get paths
  const homeDir = os.homedir();
  const elizaDir = path.join(homeDir, ".eliza");
  const globalEnvPath = path.join(elizaDir, ".env");
  const cacheDir = path.join(elizaDir, "cache");
  const dbDir = path.join(elizaDir, "db");
  
  // Remove global .env file
  if (existsSync(globalEnvPath)) {
    await fs.unlink(globalEnvPath);
    logger.success("Removed global .env file");
  }
  
  // Wipe cache folder
  if (existsSync(cacheDir)) {
    await rimraf(cacheDir);
    logger.success("Wiped cache folder");
  }
  
  // Ask if user wants to reset database too
  const { resetDb } = await prompts({
    type: "confirm",
    name: "resetDb",
    message: "Do you also want to reset the database folder?",
    initial: false,
  });
  
  if (resetDb && existsSync(dbDir)) {
    await rimraf(dbDir);
    logger.success("Wiped database folder");
  }
  
  logger.success("Environment reset complete");
}

// Create command for managing environment variables
export const env = new Command()
  .name("env")
  .description("Manage environment variables and secrets");

// List subcommand
env
  .command("list")
  .description("List all environment variables")
  .action(async () => {
    try {
      await listEnvVars();
    } catch (error) {
      handleError(error);
    }
  });

// Edit global subcommand
env
  .command("edit-global")
  .description("Edit global environment variables")
  .action(async () => {
    try {
      await editEnvVars("global");
    } catch (error) {
      handleError(error);
    }
  });

// Edit local subcommand
env
  .command("edit-local")
  .description("Edit local environment variables")
  .action(async () => {
    try {
      await editEnvVars("local");
    } catch (error) {
      handleError(error);
    }
  });

// Reset subcommand
env
  .command("reset")
  .description("Reset all environment variables and wipe the cache folder")
  .action(async () => {
    try {
      await resetEnv();
    } catch (error) {
      handleError(error);
    }
  });

// Default command (list if no subcommand provided)
env
  .action(async () => {
    try {
      await listEnvVars();

      // wait 100ms
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Ask the user if they want to edit environment variables
      const { scope } = await prompts({
        type: "select",
        name: "scope",
        message: "Would you like to edit environment variables?",
        choices: [
          { title: "Edit global variables", value: "global" },
          { title: "Edit local variables", value: "local" },
          { title: "Exit", value: "exit" }
        ]
      });
      
      if (scope && scope !== "exit") {
        await editEnvVars(scope);
      }
    } catch (error) {
      handleError(error);
    }
  });

// Register command with the CLI
export default function registerCommand(cli: Command) {
  return cli.addCommand(env);
} 