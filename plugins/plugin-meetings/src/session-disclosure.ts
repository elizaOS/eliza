/**
 * Per-viewer meeting-session DTO selection (#14781) — the use-case layer the
 * meetings routes delegate to, so no disclosure computation lives in the route
 * layer. A session references its transcript by id; what a viewer may see of
 * that transcript is decided by the ONE role-aware predicate in core
 * (`resolveArtifactDisclosure`) fed with the stored transcript row's scope,
 * owning entity, and share grants:
 *
 *   full     → session served as stored
 *   redacted → `transcriptId` kept + `transcriptRedacted: true` (the
 *              transcripts API serves that viewer the redacted variant under
 *              the same id, so the reference stays navigable)
 *   none     → `transcriptId` withheld (the roster/lifecycle fields remain —
 *              session existence is room knowledge, the transcript is not)
 *
 * No access context means the single-owner local boundary: served unchanged.
 */
import type { AccessContext, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  parseArtifactShareGrants,
  resolveArtifactDisclosure,
} from "@elizaos/core";
import type { MeetingSession } from "@elizaos/shared";
import type { TranscriptScope } from "@elizaos/shared/transcripts";
import { normalizeTranscriptScope } from "@elizaos/shared/transcripts";

function transcriptScopeFromRow(row: Memory): TranscriptScope {
  const raw = (row.content as { transcript?: unknown } | undefined)?.transcript;
  if (typeof raw !== "string") return "owner-private";
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeTranscriptScope(
      parsed && typeof parsed === "object"
        ? (parsed as { scope?: unknown }).scope
        : undefined,
    );
  } catch {
    // error-policy:J3 untrusted stored JSON — an unparseable transcript row
    // fails CLOSED to owner-private so corruption can never widen visibility.
    return "owner-private";
  }
}

/**
 * Select the session DTO for one viewer. Reads the linked transcript row and
 * applies the canonical disclosure decision; a missing row withholds the
 * reference (fail closed — a dangling id must not read as shareable).
 */
export async function selectSessionForViewer(
  runtime: Pick<IAgentRuntime, "agentId" | "getMemoryById">,
  accessContext: AccessContext | undefined,
  session: MeetingSession,
): Promise<MeetingSession> {
  if (!accessContext || !session.transcriptId) return session;
  const row = await runtime.getMemoryById(session.transcriptId as UUID);
  if (!row) {
    const { transcriptId: _transcriptId, ...withheld } = session;
    return withheld;
  }
  const metadata = row.metadata as Record<string, unknown> | undefined;
  const scopedTo = metadata?.scopedToEntityId;
  const disclosure = resolveArtifactDisclosure(
    {
      scope: transcriptScopeFromRow(row),
      scopedEntityId:
        typeof scopedTo === "string" ? (scopedTo as UUID) : row.entityId,
      grants: parseArtifactShareGrants(metadata),
    },
    accessContext,
    runtime.agentId as UUID,
  );
  if (disclosure === "full") return session;
  if (disclosure === "redacted") {
    return { ...session, transcriptRedacted: true };
  }
  const { transcriptId: _transcriptId, ...withheld } = session;
  return withheld;
}
