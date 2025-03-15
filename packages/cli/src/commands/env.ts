import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleError } from "@/src/utils/handle-error";
import { logger } from "@elizaos/core";
import { Command } from "commander";
import dotenv from "dotenv";
import prompts from "prompts";
import { rimraf } from "rimraf";
import colors from "yoctocolors";

// Path to store the custom env path setting in the config.json file
const CONFIG_FILE = path.join(os.homedir(), ".eliza", "config.json");

/**
 * Get the custom env path if one has been set
 * @returns The custom env path or null if not set
 */
async function getCustomEnvPath(): Promise<string | null> {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }
    
    const content = await fs.readFile(CONFIG_FILE, "utf-8");
    const config = JSON.parse(content);
    return config.envPath || null;
  } catch (error) {
    logger.error(`Error reading custom env path: ${error.message}`);
    return null;
  }
}

/**
 * Save a custom env path to the config file
 * @param customPath The path to save
 */
async function saveCustomEnvPath(customPath: string): Promise<void> {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }
    
    // Preserve existing config if it exists
    let config = {};
    if (existsSync(CONFIG_FILE)) {
      try {
        const content = await fs.readFile(CONFIG_FILE, "utf-8");
        config = JSON.parse(content);
      } catch (e) {
        logger.warn(`Could not parse existing config file: ${e.message}`);
      }
    }
    
    // Update the config with the new env path
    config = {
      ...config,
      envPath: customPath
    };
    
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    logger.success(`Custom environment path set to: ${customPath}`);
  } catch (error) {
    logger.error(`Error saving custom env path: ${error.message}`);
  }
}

/**
 * Get the path to the global .env file in the user's home directory or custom location
 * @returns The path to the global .env file
 */
async function getGlobalEnvPath(): Promise<string> {
  const customPath = await getCustomEnvPath();
  if (customPath) {
    return customPath;
  }
  
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
  const globalEnvPath = await getGlobalEnvPath();
  const localEnvPath = getLocalEnvPath();
  
  const globalEnvVars = await parseEnvFile(globalEnvPath);
  const localEnvVars = localEnvPath ? await parseEnvFile(localEnvPath) : {};
  
  const customPath = await getCustomEnvPath();
  const globalEnvLabel = customPath 
    ? `Global environment variables (custom path: ${customPath})`
    : "Global environment variables (.eliza/.env)";
  
  logger.info(colors.bold(`\n${globalEnvLabel}:`));
  if (Object.keys(globalEnvVars).length === 0) {
    logger.info("  No global environment variables set");
  } else {
    Object.entries(globalEnvVars).forEach(([key, value]) => {
      logger.info(`  ${colors.green(key)}: ${maskedValue(value)}`);
    });
  }
  
  if (localEnvPath) {
    logger.info(colors.bold("\nLocal environment variables (.env):"));
    if (Object.keys(localEnvVars).length === 0) {
      logger.info("  No local environment variables set");
    } else {
      Object.entries(localEnvVars).forEach(([key, value]) => {
        logger.info(`  ${colors.green(key)}: ${maskedValue(value)}`);
      });
    }
  } else {
    logger.info(colors.bold("\nNo local .env file found in the current directory"));
  }
  
  logger.info("\n");
  logger.info(colors.cyan("You can also edit environment variables in the web UI: http://localhost:3000/settings"));
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
 * @returns A boolean indicating whether the user wants to go back to the main menu
 */
async function editEnvVars(scope: "global" | "local", fromMainMenu = false): Promise<boolean> {
  const envPath = scope === "global" 
    ? await getGlobalEnvPath() 
    : getLocalEnvPath();
  
  if (scope === "local" && !envPath) {
    const { createLocal } = await prompts({
      type: "confirm",
      name: "createLocal",
      message: "No local .env file found. Create one?",
      initial: true,
    });
    
    if (!createLocal) {
      return fromMainMenu; // Return to main menu if we came from there
    }
    
    // Create an empty local .env file
    await writeEnvFile(path.join(process.cwd(), ".env"), {});
    logger.success("Created empty local .env file");
    return fromMainMenu; // Return to main menu if we came from there
  }
  
  const envVars = await parseEnvFile(envPath);
  
  // List current variables first
  logger.info(colors.bold(`\nCurrent ${scope} environment variables:`));
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
    
    return fromMainMenu; // Return to main menu if we came from there
  }
  
  // Keep looping until the user chooses to exit
  let exit = false;
  let returnToMain = false;
  
  while (!exit) {
    // Create menu choices from the environment variables
    const entries = Object.entries(envVars);
    const choices = [
      ...entries.map(([key, value]) => ({
        title: `${key}: ${maskedValue(value)}`,
        value: key,
      })),
      { title: "Add new variable", value: "add_new" },
      fromMainMenu 
        ? { title: "Back to main menu", value: "back_to_main" }
        : { title: "Exit", value: "exit" },
    ];
    
    // Prompt user to select a variable or action
    const { selection } = await prompts({
      type: "select",
      name: "selection",
      message: "Select a variable to edit or an action:",
      choices,
    });
    
    if (!selection) {
      // If user cancels (Ctrl+C), go back to main menu if we came from there
      return fromMainMenu;
    }
    
    if (selection === "exit" || selection === "back_to_main") {
      exit = true;
      returnToMain = selection === "back_to_main";
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
  
  return returnToMain && fromMainMenu;
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
  const globalEnvPath = await getGlobalEnvPath();
  const cacheDir = path.join(elizaDir, "cache");
  const dbDir = path.join(elizaDir, "db");
  
  // Remove global .env file
  if (existsSync(globalEnvPath)) {
    await fs.unlink(globalEnvPath);
    logger.success("Removed global .env file");
  }
  
  // Clear custom env path if set
  if (existsSync(CONFIG_FILE)) {
    try {
      const content = await fs.readFile(CONFIG_FILE, "utf-8");
      const config = JSON.parse(content);
      
      if (config.envPath) {
        delete config.envPath;
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
        logger.success("Cleared custom environment path setting");
      }
    } catch (error) {
      logger.error(`Error clearing custom env path: ${error.message}`);
    }
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

/**
 * Set a custom path for the global .env file
 * @param customPath The custom path to use
 */
async function setEnvPath(customPath: string): Promise<void> {
  // Validate the path
  const resolvedPath = path.resolve(customPath);
  const isDirectory = existsSync(resolvedPath) && (await fs.stat(resolvedPath)).isDirectory();
  
  let finalPath = resolvedPath;
  if (isDirectory) {
    finalPath = path.join(resolvedPath, ".env");
    logger.info(`Path is a directory. Will use ${finalPath} for environment variables.`);
  }
  
  // Check if parent directory exists
  const parentDir = path.dirname(finalPath);
  if (!existsSync(parentDir)) {
    const { createDir } = await prompts({
      type: "confirm",
      name: "createDir",
      message: `Directory ${parentDir} does not exist. Create it?`,
      initial: true,
    });
    
    if (createDir) {
      await fs.mkdir(parentDir, { recursive: true });
      logger.success(`Created directory: ${parentDir}`);
    } else {
      logger.info("Custom path not set");
      return;
    }
  }
  
  // If the file doesn't exist, create an empty one
  if (!existsSync(finalPath)) {
    const { createFile } = await prompts({
      type: "confirm",
      name: "createFile",
      message: `Environment file doesn't exist at ${finalPath}. Create an empty one?`,
      initial: true,
    });
    
    if (createFile) {
      await writeEnvFile(finalPath, {});
      logger.success(`Created empty .env file at ${finalPath}`);
    }
  }
  
  await saveCustomEnvPath(finalPath);
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

// Set custom path subcommand
env
  .command("set-path <path>")
  .description("Set a custom path for the global environment file")
  .action(async (customPath: string) => {
    try {
      await setEnvPath(customPath);
    } catch (error) {
      handleError(error);
    }
  });

// Interactive mode
env
  .command("interactive")
  .description("Interactive environment variable management")
  .action(async () => {
    try {
      await showMainMenu();
    } catch (error) {
      handleError(error);
    }
  });

// Default command (show help if no subcommand provided)
env.action(() => {
  // Show available subcommands
  console.log(colors.bold("\nEliza Environment Variable Manager"));
  console.log("\nAvailable commands:");
  console.log("  list                  List all environment variables");
  console.log("  edit-global           Edit global environment variables");
  console.log("  edit-local            Edit local environment variables");
  console.log("  set-path <path>       Set a custom path for the global environment file");
  console.log("  reset                 Reset all environment variables and wipe the cache folder");
  console.log("  interactive           Start interactive environment variable manager");
  console.log("\nYou can also edit environment variables in the web UI:");
  console.log("  http://localhost:3000/settings");
});

/**
 * Display the main menu for environment variables
 */
async function showMainMenu(): Promise<void> {
  let exit = false;
  
  while (!exit) {
    const { action } = await prompts({
      type: "select",
      name: "action",
      message: "Select an action:",
      choices: [
        { title: "List environment variables", value: "list" },
        { title: "Edit global environment variables", value: "edit_global" },
        { title: "Edit local environment variables", value: "edit_local" },
        { title: "Set custom environment path", value: "set_path" },
        { title: "Reset environment variables", value: "reset" },
        { title: "Exit", value: "exit" },
      ],
    });
    
    if (!action || action === "exit") {
      exit = true;
      continue;
    }
    
    switch (action) {
      case "list":
        await listEnvVars();
        break;
      case "edit_global": {
        const returnToMainFromGlobal = await editEnvVars("global", true);
        exit = !returnToMainFromGlobal;
        break;
      }
      case "edit_local": {
        const returnToMainFromLocal = await editEnvVars("local", true);
        exit = !returnToMainFromLocal;
        break;
      }
      case "set_path":
        logger.info(colors.yellow("\nTo set a custom path, run: eliza env set-path <path>"));
        break;
      case "reset":
        await resetEnv();
        break;
    }
  }
}

 