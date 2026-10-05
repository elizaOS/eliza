/**
 * Classifies recoverable PGlite startup failures and quarantines only the
 * managed `.elizadb` directory before a single retry. The runtime host consumes
 * this module; database recovery never owns process or server lifecycle.
 */
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  getLastFailedPluginNames,
  loadElizaConfig,
  resolveDefaultAgentWorkspaceDir,
} from "@elizaos/agent";
import { formatError, logger, resolveUserPath } from "@elizaos/core";

import {
  createPgliteInitError,
  getPgliteErrorCode,
  PGLITE_ERROR_CODES,
} from "@elizaos/plugin-sql/errors";
import { resetPluginSqlPgliteSingleton } from "../pglite-auto-reset.js";

type ErrorWithCause = Error & {
  cause?: unknown;
  code?: unknown;
  dataDir?: unknown;
};

function collectErrorObjects(err: unknown): ErrorWithCause[] {
  const chain: ErrorWithCause[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      chain.push(current as ErrorWithCause);
      current = (current as ErrorWithCause).cause;
      continue;
    }
    if (typeof current === "object" && current !== null) {
      const candidate = current as ErrorWithCause;
      chain.push(candidate);
      current = candidate.cause;
      continue;
    }
    break;
  }

  return chain;
}

function collectErrorMessages(err: unknown): string[] {
  const messages: string[] = [];
  for (const current of collectErrorObjects(err)) {
    if (typeof current.message === "string" && current.message) {
      messages.push(current.message);
    }
  }
  return messages;
}

function isManualResetPgliteError(err: unknown): boolean {
  const code = getPgliteErrorCode(err);
  return (
    code === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED ||
    code === PGLITE_ERROR_CODES.CORRUPT_DATA
  );
}

function getPgliteDataDirFromError(err: unknown): string | null {
  for (const current of collectErrorObjects(err)) {
    if (typeof current.dataDir === "string" && current.dataDir.trim()) {
      return current.dataDir;
    }
  }

  return null;
}

function resolveManagedPgliteDataDir(): string | null {
  const envDataDir = process.env.PGLITE_DATA_DIR?.trim();
  if (envDataDir) return resolveUserPath(envDataDir);

  const config = loadElizaConfig();
  if ((config.database?.provider ?? "pglite") === "postgres") return null;

  const configuredDataDir = config.database?.pglite?.dataDir?.trim();
  if (configuredDataDir) return resolveUserPath(configuredDataDir);

  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  return path.join(resolveUserPath(workspaceDir), ".elizadb");
}

function isAutoResettablePgliteDir(dataDir: string | null): dataDir is string {
  return typeof dataDir === "string" && path.basename(dataDir) === ".elizadb";
}

async function quarantinePgliteDataDir(
  dataDir: string,
): Promise<string | null> {
  if (!existsSync(dataDir)) return null;

  const parentDir = path.dirname(dataDir);
  const baseName = path.basename(dataDir);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const now = Date.now();
    const suffix = attempt === 0 ? `${now}` : `${now}-${attempt}`;
    const backupDir = path.join(parentDir, `${baseName}.corrupt-${suffix}`);
    if (existsSync(backupDir)) continue;
    await rename(dataDir, backupDir);
    return backupDir;
  }

  throw new Error(`Could not allocate a backup path for ${dataDir}`);
}

/** Preserve typed storage recovery metadata through host error wrapping. */
export function normalizePgliteStartupError(err: unknown): unknown {
  if (!isManualResetPgliteError(err)) return err;
  if (
    err instanceof Error &&
    getPgliteErrorCode(err) === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED
  ) {
    return err;
  }

  const dataDir =
    getPgliteDataDirFromError(err) ?? resolveManagedPgliteDataDir();
  const detail = collectErrorMessages(err)[0] ?? formatError(err);
  return createPgliteInitError(
    PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
    dataDir
      ? `PGlite initialization failed for ${dataDir}: ${detail}. Stop the app, then rename or delete only this directory before retrying: ${dataDir}`
      : `PGlite initialization failed: ${detail}. Stop the app, then rename or delete only the managed PGlite data directory before retrying.`,
    { cause: err, ...(dataDir ? { dataDir } : {}) },
  );
}

/** Quarantine a managed corrupt database and reset plugin-sql before retry. */
export async function attemptPgliteAutoReset(
  err: unknown,
): Promise<string | null> {
  if (!isManualResetPgliteError(err)) return null;

  const dataDir =
    getPgliteDataDirFromError(err) ?? resolveManagedPgliteDataDir();
  if (!isAutoResettablePgliteDir(dataDir)) return null;

  logger.warn(
    `[eliza] PGlite startup failed for ${dataDir}. Quarantining the local database before retrying.`,
  );
  await resetPluginSqlPgliteSingleton("PGlite auto-reset");
  const backupDir = await quarantinePgliteDataDir(dataDir);
  if (backupDir) {
    logger.warn(`[eliza] Moved the previous PGlite data dir to ${backupDir}`);
  }
  await resetPluginSqlPgliteSingleton("PGlite auto-reset retry");
  return backupDir;
}

/** Plugins implicated in the failed boot are omitted from the recovery retry. */
export function getPgliteRecoveryRetrySkipPlugins(): string[] {
  return getLastFailedPluginNames();
}
