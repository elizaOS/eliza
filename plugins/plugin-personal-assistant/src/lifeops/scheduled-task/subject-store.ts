/**
 * Real `SubjectStoreView` for the ScheduledTask spine.
 *
 * `subject_updated` completion-checks ask "was this subject's row updated
 * since `sinceIso`?". This module answers from the production stores instead
 * of the previous warn-once `false` shim:
 *
 *  - `entity`        → `EntityStore.get(id).updatedAt` (KnowledgeGraphService)
 *  - `relationship`  → `Relationship.updatedAt` OR `state.lastInteractionAt`,
 *                      whichever is newer — a logged interaction on the edge
 *                      is exactly the "any new interaction resolves the
 *                      followup" signal the followup-starter pack documents.
 *  - `thread`        → `WorkThread.updatedAt` OR `lastActivityAt`.
 *  - `document` / `calendar_event` / `self` → no durable per-id store binding
 *    exists yet (documents are a Wave-1 in-memory map private to the OWNER_
 *    DOCUMENTS action; calendar events have no by-id reader; "self" has no
 *    update timestamp). These report not-updated with a warn-once per kind so
 *    the gap stays visible instead of silently passing/failing.
 *
 * A missing subject row is honest "not updated" (`false`), not an error: the
 * check asks about an update signal, and an absent row has none.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import type {
  ScheduledTaskSubject,
  SubjectStoreView,
} from "@elizaos/plugin-scheduling";
import { LifeOpsRepository } from "../repository.js";

const LOG_SRC = "lifeops:scheduled-task:subject-store";

function isUpdatedSince(
  sinceIso: string,
  ...candidates: Array<string | undefined | null>
): boolean {
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return false;
  return candidates.some((iso) => {
    if (typeof iso !== "string") return false;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && ms >= sinceMs;
  });
}

/**
 * Build the production SubjectStoreView bound to this runtime's
 * KnowledgeGraphService (entities / relationships) and LifeOpsRepository
 * (work threads).
 */
export function createLifeOpsSubjectStoreView(
  runtime: IAgentRuntime,
  agentId: string,
): SubjectStoreView {
  const repo = new LifeOpsRepository(runtime);
  const warnedKinds = new Set<string>();

  const warnUnboundKind = (kind: string): false => {
    if (!warnedKinds.has(kind)) {
      warnedKinds.add(kind);
      logger.warn(
        { src: LOG_SRC, agentId, subjectKind: kind },
        `[LifeOpsSubjectStore] no store binding for subject kind "${kind}"; subject_updated completion-checks on it report not-updated.`,
      );
    }
    return false;
  };

  return {
    async wasUpdatedSince(args: {
      subject: ScheduledTaskSubject;
      sinceIso: string;
    }): Promise<boolean> {
      const { subject, sinceIso } = args;
      switch (subject.kind) {
        case "entity": {
          const store = await repo.entityStore(agentId);
          const entity = await store.get(subject.id);
          return entity ? isUpdatedSince(sinceIso, entity.updatedAt) : false;
        }
        case "relationship": {
          const store = await repo.relationshipStore(agentId);
          const edge = await store.get(subject.id);
          return edge
            ? isUpdatedSince(
                sinceIso,
                edge.updatedAt,
                edge.state.lastInteractionAt,
              )
            : false;
        }
        case "thread": {
          const thread = await repo.getWorkThread(agentId, subject.id);
          return thread
            ? isUpdatedSince(sinceIso, thread.updatedAt, thread.lastActivityAt)
            : false;
        }
        // document / calendar_event / self — no store binding yet.
        default:
          return warnUnboundKind(subject.kind);
      }
    },
  };
}
