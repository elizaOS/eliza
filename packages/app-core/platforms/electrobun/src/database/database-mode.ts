/** Implements Electrobun desktop database mode ts behavior for app-core shell integration. */
import type { DatabaseMode } from "./database-snapshot";
import {
  isMemoryPgliteDataDir,
  resolveDefaultPgliteDataDir,
  resolvePgliteDataDirPath,
} from "./pglite-paths";

export type DatabaseModeResolutionSource =
  | "POSTGRES_URL"
  | "DATABASE_URL"
  | "PGLITE_DATA_DIR"
  | "packaged-desktop-default"
  | "explicit-memory"
  | "unknown";

export interface DatabaseModeResolution {
  mode: DatabaseMode;
  postgresUrl?: string;
  pgliteDataDir?: string;
  source: DatabaseModeResolutionSource;
  warnings: string[];
  databaseUrlMapped: boolean;
}

export interface DatabaseModeResolverOptions {
  env: Record<string, string | undefined>;
  packagedDesktop: boolean;
  appStateDir: string;
  cwd?: string;
}

export function redactDatabaseTarget(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.username) url.username = "[user]";
    if (url.password) url.password = "[password]";
    return url.toString();
  } catch {
    return trimmed.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://[user]:[password]@");
  }
}

function normalizedEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isMemoryMode(value: string | undefined): boolean {
  const normalized = normalizedEnvValue(value)?.toLowerCase();
  return normalized === "memory" || normalized === "pglite-memory";
}

export function resolveDatabaseMode(
  options: DatabaseModeResolverOptions,
): DatabaseModeResolution {
  const warnings: string[] = [];
  const postgresUrl = normalizedEnvValue(options.env.POSTGRES_URL);
  if (postgresUrl) {
    return {
      mode: "postgres",
      postgresUrl,
      source: "POSTGRES_URL",
      warnings,
      databaseUrlMapped: false,
    };
  }

  const databaseUrl = normalizedEnvValue(options.env.DATABASE_URL);
  if (databaseUrl) {
    warnings.push(
      "DATABASE_URL is mapped to POSTGRES_URL for the agent runtime.",
    );
    return {
      mode: "postgres",
      postgresUrl: databaseUrl,
      source: "DATABASE_URL",
      warnings,
      databaseUrlMapped: true,
    };
  }

  if (isMemoryMode(options.env.ELIZA_DB_MODE)) {
    return {
      mode: "pglite-memory",
      pgliteDataDir: "memory://",
      source: "explicit-memory",
      warnings,
      databaseUrlMapped: false,
    };
  }

  const pgliteDataDir = normalizedEnvValue(options.env.PGLITE_DATA_DIR);
  if (pgliteDataDir) {
    return {
      mode: isMemoryPgliteDataDir(pgliteDataDir)
        ? "pglite-memory"
        : "pglite-persistent",
      pgliteDataDir: isMemoryPgliteDataDir(pgliteDataDir)
        ? "memory://"
        : resolvePgliteDataDirPath(pgliteDataDir, options.cwd),
      source: "PGLITE_DATA_DIR",
      warnings,
      databaseUrlMapped: false,
    };
  }

  if (options.packagedDesktop) {
    return {
      mode: "pglite-persistent",
      pgliteDataDir: resolveDefaultPgliteDataDir({
        appStateDir: options.appStateDir,
      }),
      source: "packaged-desktop-default",
      warnings,
      databaseUrlMapped: false,
    };
  }

  warnings.push(
    "No desktop database env was set; the child runtime will use its development database policy.",
  );
  return {
    mode: "unknown",
    source: "unknown",
    warnings,
    databaseUrlMapped: false,
  };
}

export function applyDatabaseResolutionToEnv(
  childEnv: Record<string, string>,
  resolution: DatabaseModeResolution,
): void {
  if (resolution.mode === "postgres" && resolution.postgresUrl) {
    childEnv.POSTGRES_URL = resolution.postgresUrl;
    delete childEnv.PGLITE_DATA_DIR;
    return;
  }
  if (
    (resolution.mode === "pglite-persistent" ||
      resolution.mode === "pglite-memory") &&
    resolution.pgliteDataDir
  ) {
    childEnv.PGLITE_DATA_DIR = resolution.pgliteDataDir;
    delete childEnv.POSTGRES_URL;
  }
}
