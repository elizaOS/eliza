import { UserEnvironment } from '@/src/utils';
import { RuntimeSettings } from '@elizaos/core';
import dotenv from 'dotenv';

/**
 * Load environment configuration for runtime
 *
 * Loads environment variables from the project's .env file and returns them as runtime settings.
 */
export async function loadEnvConfig(): Promise<RuntimeSettings> {
  const envInfo = await UserEnvironment.getInstanceInfo();
  if (envInfo.paths.envFilePath) {
    dotenv.config({ path: envInfo.paths.envFilePath });
  }
  return process.env as RuntimeSettings;
}
