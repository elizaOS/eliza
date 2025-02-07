import path from "node:path"
import { cosmiconfig } from "cosmiconfig"
import { z } from "zod"

const explorer = cosmiconfig("eliza", {
  searchPlaces: ["project.json"],
})

// Database config schemas
const sqliteConfigSchema = z.object({
  type: z.literal("sqlite"),
  config: z.object({
    path: z.string(),
  }),
})

const postgresConfigSchema = z.object({
  type: z.literal("postgres"),
  config: z.object({
    url: z.string(),
  }),
})

const redisConfigSchema = z.object({
  type: z.literal("redis"),
  config: z.object({
    url: z.string(),
  }),
})

// Main config schema
export const rawConfigSchema = z
  .object({
    $schema: z.string().optional(),
    database: z.discriminatedUnion("type", [
      sqliteConfigSchema,
      postgresConfigSchema,
      redisConfigSchema,
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
  } catch (error) {
    throw new Error(`Invalid configuration found in ${cwd}/project.json.`)
  }
}