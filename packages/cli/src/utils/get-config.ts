import path from "node:path"
import { cosmiconfig } from "cosmiconfig"
import { z } from "zod"
import { existsSync } from 'node:fs';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import dotenv from 'dotenv';

const explorer = cosmiconfig("eliza", {
  searchPlaces: ["project.json"],
})

// Database config schemas
const postgresConfigSchema = z.object({
  type: z.literal("postgres"),
  config: z.object({
    url: z.string(),
  }),
})

const pgliteConfigSchema = z.object({
  type: z.literal("pglite"),
  config: z.object({
    dataDir: z.string(),
  }),
})

// Main config schema
export const rawConfigSchema = z
  .object({
    $schema: z.string().optional(),
    database: z.discriminatedUnion("type", [
      postgresConfigSchema,
      pgliteConfigSchema,
    ]),
    plugins: z.object({
      registry: z.string().url(),
      installed: z.array(z.string()),
    }),
    paths: z.object({
      knowledge: z.string(),
    }),
  })
  .strict()

export type RawConfig = z.infer<typeof rawConfigSchema>

export const configSchema = rawConfigSchema.extend({
  resolvedPaths: z.object({
    knowledge: z.string(),
  }),
})

export type Config = z.infer<typeof configSchema>

export async function getConfig(cwd: string) {
  const config = await getRawConfig(cwd)

  if (!config) {
    return null
  }

  return await resolveConfigPaths(cwd, config)
}

export async function resolveConfigPaths(cwd: string, config: RawConfig) {
  return configSchema.parse({
    ...config,
    resolvedPaths: {
      knowledge: path.resolve(cwd, config.paths.knowledge),
    },
  })
}

export async function getRawConfig(cwd: string): Promise<RawConfig | null> {
  try {
    const configResult = await explorer.search(cwd)

    if (!configResult) {
      return null
    }

    return rawConfigSchema.parse(configResult.config)
  } catch (_error) {
    throw new Error(`Invalid configuration found in ${cwd}/project.json.`)
  }
}

/**
 * Load environment variables, trying project .env first, then global ~/.eliza/.env
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