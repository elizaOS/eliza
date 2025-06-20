import { UserEnvironment } from '@/src/utils';
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EnvVars } from '../types';

/**
 * Get the path to the project's .env file.
 * @returns The path to the .env file
 */
export async function getGlobalEnvPath(): Promise<string> {
  const envInfo = await UserEnvironment.getInstanceInfo();
  return envInfo.paths.envFilePath;
}

/**
 * Get the path to the local .env file in the current directory
 * @returns The path to the local .env file or null if not found
 */
export async function getLocalEnvPath(): Promise<string | null> {
  const localEnvPath = path.join(process.cwd(), '.env');
  return existsSync(localEnvPath) ? localEnvPath : null;
}

/**
 * Parse an .env file and return the key-value pairs
 * @param filePath Path to the .env file
 * @returns Object containing the key-value pairs
 */
export async function parseEnvFile(filePath: string): Promise<EnvVars> {
  try {
    if (!existsSync(filePath)) {
      return {};
    }

    const content = await fs.readFile(filePath, 'utf-8');
    // Handle empty file case gracefully
    if (content.trim() === '') {
      return {};
    }
    return dotenv.parse(content);
  } catch (error) {
    console.error(
      `Error parsing .env file: ${error instanceof Error ? error.message : String(error)}`
    );
    return {};
  }
}

/**
 * Write key-value pairs to an .env file
 * @param filePath Path to the .env file
 * @param envVars Object containing the key-value pairs
 */
export async function writeEnvFile(filePath: string, envVars: EnvVars): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }

    const content = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    await fs.writeFile(filePath, content);
  } catch (error) {
    console.error(
      `Error writing .env file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Helper function to reset an environment file by keeping keys but clearing values
 * @param filePath Path to the environment file
 * @returns A boolean indicating success/failure
 */
export async function resetEnvFile(filePath: string): Promise<boolean> {
  try {
    if (!existsSync(filePath)) {
      return false;
    }

    const envVars = await parseEnvFile(filePath);
    if (Object.keys(envVars).length === 0) {
      return false; // No variables to reset
    }

    const resetVars = Object.keys(envVars).reduce((acc, key) => {
      acc[key] = '';
      return acc;
    }, {} as EnvVars);

    await writeEnvFile(filePath, resetVars);
    return true;
  } catch (error) {
    console.error(
      `Error resetting environment file: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
