import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Database config schemas
const postgresConfigSchema = z.object({
  type: z.literal('postgres'),
  config: z.object({
    url: z.string().optional(),
  }),
});

const pgliteConfigSchema = z.object({
  type: z.literal('pglite'),
  config: z.object({
    dataDir: z.string(),
  }),
});

// Main config schema
/**
 * Schema definition for the raw configuration object.
 *
 * @type {z.ZodType<RawConfig>}
 */
export const rawConfigSchema = z
  .object({
    $schema: z.string().optional(),
    database: z.discriminatedUnion('type', [postgresConfigSchema, pgliteConfigSchema]),
    plugins: z.object({
      registry: z.string().url(),
      installed: z.array(z.string()),
    }),
    paths: z.object({
      knowledge: z.string(),
    }),
  })
  .strict();

/**
 * Type definition for the inferred type of the raw config schema.
 */
export type RawConfig = z.infer<typeof rawConfigSchema>;

export const configSchema = rawConfigSchema.extend({
  resolvedPaths: z.object({
    knowledge: z.string(),
  }),
});

/**
 * Define the type `Config` as the inferred type from the `configSchema`.
 */
export type Config = z.infer<typeof configSchema>;

/**
 * Resolves the paths in the given configuration based on the provided current working directory (cwd).
 * @param {string} cwd - The current working directory.bun run b
 * @param {RawConfig} config - The raw configuration object.
 * @returns {Promise<ResolvedConfig>} The resolved configuration object with updated paths.
 */
export async function resolveConfigPaths(cwd: string, config: RawConfig) {
  return configSchema.parse({
    ...config,
    resolvedPaths: {
      knowledge: path.resolve(cwd, config.paths.knowledge),
    },
  });
}

/**
 * Load environment variables, trying project .env first, then global ~/.eliza/.env
 */
/**
 * Loads environment variables from either the project directory or global config.
 * If the .env file is found in the project directory, it will be loaded.
 * If not found in the project directory, it will try to load from the global config.
 * If neither exist, it will create the global .env file with a default comment.
 *
 * @param {string} projectDir - The directory where the project is located (default: process.cwd()).
 * @returns {Promise<void>} A Promise that resolves once the environment variables are loaded or created.
 */
export async function loadEnvironment(projectDir: string = process.cwd()): Promise<void> {
  const projectEnvPath = path.join(projectDir, '.env');
  const globalEnvDir = path.join(os.homedir(), '.eliza');
  const globalEnvPath = path.join(globalEnvDir, '.env');

  // First try loading from project directory
  if (existsSync(projectEnvPath)) {
    dotenv.config({ path: projectEnvPath });
    return;
  }

  // If not found, try loading from global config
  if (existsSync(globalEnvPath)) {
    dotenv.config({ path: globalEnvPath });
    return;
  }

  // If neither exists, create the global .env
  if (!existsSync(globalEnvDir)) {
    await fs.mkdir(globalEnvDir, { recursive: true });
  }

  // Create an empty .env file
  if (!existsSync(globalEnvPath)) {
    await fs.writeFile(globalEnvPath, '# Global environment variables for Eliza\n');
  }
}
