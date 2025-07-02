import { getEnvFileService, createEnvFileService } from '@/src/services/env-file.service';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { EnvVars } from '../types';

/**
 * Get the path to the project's .env file.
 * @returns The path to the .env file
 */
export async function getGlobalEnvPath(): Promise<string> {
  const service = await getEnvFileService();
  return service.getFilePath();
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
  const service = createEnvFileService(filePath);
  return service.read();
}

/**
 * Write key-value pairs to an .env file
 * @param filePath Path to the .env file
 * @param envVars Object containing the key-value pairs
 */
export async function writeEnvFile(filePath: string, envVars: EnvVars): Promise<void> {
  const service = createEnvFileService(filePath);
  await service.write(envVars, {
    preserveComments: true,
    updateProcessEnv: true,
  });
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

    const service = createEnvFileService(filePath);
    const envVars = await service.read();

    if (Object.keys(envVars).length === 0) {
      return false; // No variables to reset
    }

    const resetVars = Object.keys(envVars).reduce((acc, key) => {
      acc[key] = '';
      return acc;
    }, {} as EnvVars);

    await service.write(resetVars, {
      preserveComments: true,
      updateProcessEnv: false, // Don't update process.env with empty values
    });

    return true;
  } catch (error) {
    console.error(
      `Error resetting environment file: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
