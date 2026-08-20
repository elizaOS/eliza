/** Shared fail-closed state predicate for dormant restore authority. */

import type { AgentBackupCatalogState } from "../schemas/agent-sandboxes";

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
