import { getEnvFileService } from '@/src/services/env-file.service';
import { logger } from '@elizaos/core';

/**
 * Retrieves the absolute path to the `.env` environment file.
 *
 * @returns A promise that resolves to the full path of the environment file.
 */
export async function getEnvFilePath(): Promise<string> {
  const service = await getEnvFileService();
  return service.getFilePath();
}

/**
 * Asynchronously reads environment variables from the `.env` file and returns them as key-value pairs.
 *
 * Ignores comments and empty lines. If the file does not exist or cannot be read, returns an empty object.
 *
 * @returns A record containing environment variable names and their corresponding values.
 */
export async function readEnvFile(): Promise<Record<string, string>> {
  const service = await getEnvFileService();
  return service.read();
}

/**
 * Asynchronously writes the provided environment variables to the `.env` file, creating the directory if it does not exist.
 *
 * @param envVars - A record of environment variable key-value pairs to write.
 */
export async function writeEnvFile(envVars: Record<string, string>): Promise<void> {
  const service = await getEnvFileService();
  await service.write(envVars, {
    preserveComments: false,
    updateProcessEnv: true,
  });
}
