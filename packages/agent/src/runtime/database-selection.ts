/** Selects an explicit SQLite bootstrap without retaining a PostgreSQL fallback. */
import { ElizaError, type Plugin } from "@elizaos/core";

export const SQLITE_PLUGIN = "@elizaos/plugin-sqlite";
export const SQL_PLUGIN = "@elizaos/plugin-sql";

export function isSQLiteSelected(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const provider = env.ELIZA_DATABASE_PROVIDER;
  if (provider !== undefined && provider !== "sqlite") {
    throw new ElizaError(
      "ELIZA_DATABASE_PROVIDER currently accepts only the explicit sqlite opt-in; configure PostgreSQL/PGlite through database config",
      { code: "DATABASE_PROVIDER_INVALID" },
    );
  }
  return provider === "sqlite";
}

export function selectedDatabasePlugin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return isSQLiteSelected(env) ? SQLITE_PLUGIN : SQL_PLUGIN;
}

export function selectDatabasePluginNames(
  names: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const sqlite = isSQLiteSelected(env);
  return [
    ...new Set(
      Array.from(names, (name) =>
        name === SQL_PLUGIN && sqlite ? SQLITE_PLUGIN : name,
      ),
    ),
  ];
}

/** Rejects PostgreSQL-specific plugins before their preflight or init can run. */
export function assertSelectedDatabaseCompatibility(
  plugin: Plugin,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isSQLiteSelected(env)) return;
  const sqlDependency = plugin.dependencies?.some((name) =>
    ["sql", "plugin-sql", SQL_PLUGIN].includes(name),
  );
  if (
    sqlDependency ||
    (plugin.schema && Object.keys(plugin.schema).length > 0)
  ) {
    throw new ElizaError(
      `Plugin ${plugin.name} requires PostgreSQL storage and cannot activate with SQLite until explicitly ported`,
      {
        code: "SQLITE_PLUGIN_INCOMPATIBLE",
        context: { plugin: plugin.name },
      },
    );
  }
}
