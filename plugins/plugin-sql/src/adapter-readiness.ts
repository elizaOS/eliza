/**
 * Shared classification for plugin-sql adapter readiness checks. The entry
 * points may create a database adapter when none is registered, but other
 * readiness failures must stay visible as typed initialization errors.
 */
import { ElizaError, type UUID } from "@elizaos/core";

const MISSING_ADAPTER_MESSAGE = "Database adapter not registered";

export function describeAdapterReadinessError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissingDatabaseAdapterError(error: unknown): boolean {
  return describeAdapterReadinessError(error).includes(MISSING_ADAPTER_MESSAGE);
}

export function createAdapterReadinessError(
  error: unknown,
  context: {
    agentId: UUID;
    entrypoint: "browser" | "default" | "node";
  }
): ElizaError {
  return new ElizaError("Database adapter readiness check failed", {
    code: "DB_ADAPTER_READY_CHECK_FAILED",
    cause: error,
    context,
  });
}
