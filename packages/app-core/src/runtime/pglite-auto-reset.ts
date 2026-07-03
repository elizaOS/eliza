import { logger } from "@elizaos/core";
import { closePgliteSingleton } from "@elizaos/plugin-sql";
import { formatError } from "@elizaos/shared";

/**
 * Close the process-global plugin-sql PGlite singleton through the plugin's
 * public {@link closePgliteSingleton} API, then drop it so the next
 * `createDatabaseAdapter()` rebuilds a fresh manager. Part of the corrupt-data
 * dir auto-reset recovery: the caller quarantines the `.elizadb` directory
 * between resets. Logs (but never throws) when `close()` errors or exceeds its
 * timeout — the manager is dropped regardless so recovery can proceed.
 */
export async function resetPluginSqlPgliteSingleton(
  context: string,
): Promise<void> {
  const { closed, timedOut, error } = await closePgliteSingleton({
    timeoutMs: 1_000,
  });

  if (!closed) {
    return;
  }

  if (error) {
    logger.warn(
      `[eliza] ${context}: failed to close plugin-sql PGlite singleton: ${formatError(error)}`,
    );
  }

  if (timedOut) {
    logger.warn(
      `[eliza] ${context}: plugin-sql PGlite singleton close timed out; continuing with a forced reset`,
    );
  }
}
