import path from "node:path";

type EnvLike = Record<string, string | undefined>;

/**
 * Default PGlite data directory used when no DATABASE_URL is set in local
 * (non-CI, non-production) execution. PGlite is an in-process Postgres in
 * WASM — the cloud package uses Neon in production and PGlite for local dev,
 * so a missing DATABASE_URL silently falls back to a file-backed PGlite store
 * under `.eliza/.pgdata` instead of trying to reach a Docker container.
 */
const DEFAULT_PGLITE_DATA_DIR = ".eliza/.pgdata";

export function getLocalPGliteDatabaseUrl(env: EnvLike = process.env): string {
  const dataDir = env.PGLITE_DATA_DIR || env.LOCAL_DATABASE_PATH || DEFAULT_PGLITE_DATA_DIR;
  // pglite:// URLs are relative paths that the db client passes straight
  // through to drizzle-orm/pglite. Normalize to an absolute path so multiple
  // processes (API, migrations, tests) all touch the same store.
  const absolute = path.isAbsolute(dataDir) ? dataDir : path.resolve(process.cwd(), dataDir);
  return `pglite://${absolute}`;
}

export const LOCAL_PGLITE_DATABASE_URL = getLocalPGliteDatabaseUrl({
  PGLITE_DATA_DIR: DEFAULT_PGLITE_DATA_DIR,
});

function isLocalExecution(env: EnvLike): boolean {
  return env.NODE_ENV !== "production" && env.CI !== "true";
}

export function resolveDatabaseUrl(env: EnvLike = process.env): string | null {
  const explicitUrl = env.TEST_DATABASE_URL || env.DATABASE_URL;
  if (explicitUrl) {
    return explicitUrl;
  }

  if (env.DISABLE_LOCAL_PGLITE_FALLBACK === "1") {
    return null;
  }

  if (isLocalExecution(env)) {
    return getLocalPGliteDatabaseUrl(env);
  }

  return null;
}

export function applyDatabaseUrlFallback(env: EnvLike = process.env): string | null {
  const url = resolveDatabaseUrl(env);
  if (!url) {
    return null;
  }

  env.DATABASE_URL ??= url;
  if (env.NODE_ENV === "test") {
    env.TEST_DATABASE_URL ??= url;
  }

  return url;
}
