interface EnvLike {
  [key: string]: string | undefined;
}

export interface RuntimeDatabaseAdapterConfig {
  postgresUrl?: string;
  dataDir?: string;
}

export type RuntimeDatabaseBackend = "postgresql" | "pglite";

const DEFAULT_PGLITE_DATA_DIR = ".eliza/.elizadb";

function normalizeDatabaseBackend(env: EnvLike): RuntimeDatabaseBackend {
  const raw = (env.DATABASE_ADAPTER || env.DATABASE_ENGINE || env.DATABASE_DIALECT || "postgresql")
    .trim()
    .toLowerCase();

  if (raw === "postgres" || raw === "postgresql" || raw === "pg" || raw === "neon") {
    return "postgresql";
  }

  if (raw === "pglite" || raw === "local" || raw === "file" || raw === "sqlite") {
    return "pglite";
  }

  throw new Error(`Unsupported DATABASE_ENGINE/DATABASE_DIALECT value: ${raw}`);
}

export function getRuntimeDatabaseBackend(env: EnvLike = process.env): RuntimeDatabaseBackend {
  return normalizeDatabaseBackend(env);
}

export function resolveRuntimeDatabaseAdapterConfig(
  env: EnvLike = process.env,
): RuntimeDatabaseAdapterConfig {
  const backend = normalizeDatabaseBackend(env);

  if (backend === "pglite") {
    return {
      dataDir:
        env.PGLITE_DATA_DIR ||
        env.SQLITE_DATABASE_PATH ||
        env.SQLITE_DATABASE_URL ||
        env.LOCAL_DATABASE_PATH ||
        DEFAULT_PGLITE_DATA_DIR,
    };
  }

  const postgresUrl = env.POSTGRES_URL || env.DATABASE_URL;
  if (!postgresUrl) {
    throw new Error("DATABASE_URL environment variable is required for PostgreSQL runtime storage");
  }

  return { postgresUrl };
}
