/**
 * Per-viewer selection for the Files list DTO (#14781) — the use-case the
 * `/api/files` route delegates to, so no disclosure computation lives in the
 * route layer. Stored files are raw content-addressed blobs with NO reference
 * metadata of their own (doctrine #8876 AD1: no file table, no per-blob ACL),
 * so the whole-store listing is an owner/admin management surface: share
 * grants live on referencing records (transcripts, messages) and disclose
 * through THOSE surfaces, never by widening the raw store list.
 *
 * Non-privileged viewers therefore get zero rows plus an explicit
 * `restricted: true` — a designed, distinguishable state (UI three-state
 * rule: restricted ≠ empty ≠ error), never a healthy-empty fabrication.
 */
import type { AccessContext, StoredFileListItem, UUID } from "@elizaos/core";
import { actorFromAccessContext } from "@elizaos/core";

/** The `GET /api/files` response body. */
export interface FilesListDto {
  files: StoredFileListItem[];
  /**
   * True when the viewer's tier cannot see the raw store listing. The client
   * renders the designed "restricted" state — distinct from an owner's
   * genuinely empty store (`files: [], restricted: false`).
   */
  restricted: boolean;
}

/**
 * Select the Files list for one viewer: the single-owner boundary (no
 * context), the agent itself, and OWNER/ADMIN-rank viewers see every stored
 * file; USER/GUEST-tier viewers see the restricted state.
 */
export function selectFilesForViewer(
  files: StoredFileListItem[],
  accessContext: AccessContext | undefined,
  agentId: UUID,
): FilesListDto {
  if (!accessContext) return { files, restricted: false };
  const actor = actorFromAccessContext(accessContext, agentId);
  if (actor.role === "OWNER" || actor.role === "AGENT") {
    return { files, restricted: false };
  }
  return { files: [], restricted: true };
}
