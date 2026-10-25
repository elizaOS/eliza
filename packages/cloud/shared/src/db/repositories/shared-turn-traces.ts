// Persists sampled shared turn trace records for cloud services through the shared DB boundary.
import { and, desc, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../client";
import {
  type NewSharedTurnTraceRow,
  type SharedTurnTraceRow,
  sharedTurnTraces,
} from "../schemas/shared-turn-traces";
import { jsonbParam } from "../utils/jsonb";

export type { NewSharedTurnTraceRow, SharedTurnTraceRow };

/** Hard cap on a recent-traces page so a diagnostics read can never table-scan. */
const MAX_LIST_LIMIT = 200;

/**
 * Storage for the sampled Shared-turn observability traces written by
 * `shared-turn-trace-recorder.ts`. Inserts carry the full tenant scope
 * (organization/user/agent are NOT NULL on the table), and every read pins
 * `organization_id` — the table has no FK back to the tenant tables, so the
 * repository is the only place scoping is enforced.
 */
export class SharedTurnTracesRepository {
  async insertTrace(trace: NewSharedTurnTraceRow): Promise<void> {
    await dbWrite.insert(sharedTurnTraces).values({
      ...trace,
      ...(trace.usage === undefined || trace.usage === null
        ? {}
        : { usage: jsonbParam(trace.usage) }),
      stages: jsonbParam(trace.stages),
    });
  }

  /**
   * Recent traces for one agent, newest first, pinned to the requesting
   * organization. The org pin is mandatory: agent ids are caller-supplied
   * text, so without it a guessed agent id would leak another tenant's traces.
   */
  async listRecentByAgent(
    organizationId: string,
    agentId: string,
    limit: number,
  ): Promise<SharedTurnTraceRow[]> {
    return await dbRead
      .select()
      .from(sharedTurnTraces)
      .where(
        and(
          eq(sharedTurnTraces.organization_id, organizationId),
          eq(sharedTurnTraces.agent_id, agentId),
        ),
      )
      .orderBy(desc(sharedTurnTraces.created_at))
      .limit(Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_LIST_LIMIT));
  }
}

export const sharedTurnTracesRepository = new SharedTurnTracesRepository();
