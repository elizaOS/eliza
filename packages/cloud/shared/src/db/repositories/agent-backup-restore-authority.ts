/** Shared fail-closed state predicate for dormant restore authority. */

import { ElizaError } from "@elizaos/core/edge";
import type { AgentBackupCatalogState } from "../schemas/agent-sandboxes";

/** Typed validation and invariant failure for dormant restore authority. */
export class AgentBackupRestoreAuthorityError extends ElizaError {
  override readonly name = "AgentBackupRestoreAuthorityError";

  constructor(code: string, message: string, options?: { cause?: unknown; field?: string }) {
    super(message, {
      code,
      cause: options?.cause,
      context: options?.field ? { field: options.field } : undefined,
    });
  }
}

export type AgentBackupRestorableCatalogState = Extract<
  AgentBackupCatalogState,
  "protected" | "retained" | "restore_verified"
>;

/** A restore always requires dual-provider protection, regardless of selected copy. */
export function hasAgentBackupRestoreAuthority(
  state: AgentBackupCatalogState | null,
): state is AgentBackupRestorableCatalogState {
  return state === "protected" || state === "retained" || state === "restore_verified";
}
