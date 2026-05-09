/**
 * Trajectory introspection actions.
 *
 * QUERY_TRAJECTORIES → GET /api/trajectories
 */

import type { Action, ActionResult, HandlerOptions } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";
import type { TrajectoryListResult } from "../types/trajectory.js";

function getApiBase(): string {
  return `http://localhost:${resolveServerOnlyPort(process.env)}`;
}

const TRAJECTORY_STATUSES = ["active", "completed", "error"] as const;
type TrajectoryStatus = (typeof TRAJECTORY_STATUSES)[number];

interface QueryTrajectoriesParams {
  source?: string;
  status?: TrajectoryStatus;
  scenarioId?: string;
  batchId?: string;
  limit?: number;
  offset?: number;
}

export const queryTrajectoriesAction: Action = {
  name: "QUERY_TRAJECTORIES",
  contexts: ["agent_internal", "admin", "documents"],
  roleGate: { minRole: "OWNER" },
  similes: ["LIST_TRAJECTORIES", "FIND_TRAJECTORIES", "BROWSE_TRAJECTORIES"],
  description:
    "List recorded trajectories with optional filters: source, status, scenarioId, batchId, plus limit/offset.",
  descriptionCompressed:
    "list record trajectory w/ optional filter: source, status, scenarioid, batchid, plus limit/offset",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | QueryTrajectoriesParams
      | undefined;

    const search = new URLSearchParams();
    if (params?.source) search.set("source", params.source);
    if (params?.status && TRAJECTORY_STATUSES.includes(params.status)) {
      search.set("status", params.status);
    }
    if (params?.scenarioId) search.set("scenarioId", params.scenarioId);
    if (params?.batchId) search.set("batchId", params.batchId);
    if (params?.limit != null) {
      search.set(
        "limit",
        String(Math.max(1, Math.min(500, Math.floor(params.limit)))),
      );
    }
    if (params?.offset != null) {
      search.set("offset", String(Math.max(0, Math.floor(params.offset))));
    }

    const qs = search.toString();
    const url = `${getApiBase()}/api/trajectories${qs ? `?${qs}` : ""}`;

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to query trajectories: HTTP ${resp.status}`,
        };
      }
      const data = (await resp.json()) as TrajectoryListResult;
      const trajectories = data.trajectories ?? [];
      const lines = trajectories
        .slice(0, 25)
        .map(
          (t) =>
            `- ${t.id} ${t.status ?? "?"} src=${t.source ?? "?"} started=${t.startTime ?? "?"}`,
        );
      return {
        success: true,
        text: [
          `Found ${trajectories.length} trajectory record(s) (total available: ${data.total}, offset: ${data.offset}).`,
          ...lines,
        ].join("\n"),
        values: {
          count: trajectories.length,
          total: data.total,
          offset: data.offset,
        },
        data: {
          actionName: "QUERY_TRAJECTORIES",
          trajectories,
          total: data.total,
          offset: data.offset,
          limit: data.limit,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[query-trajectories] failed: ${msg}`);
      return {
        success: false,
        text: `Failed to query trajectories: ${msg}`,
      };
    }
  },
  parameters: [
    {
      name: "source",
      description: "Optional source filter.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "status",
      description: "Optional status filter.",
      required: false,
      schema: { type: "string" as const, enum: [...TRAJECTORY_STATUSES] },
    },
    {
      name: "scenarioId",
      description: "Optional scenario ID filter.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "batchId",
      description: "Optional batch ID filter.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Maximum number of records to return (1-500).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "offset",
      description: "Pagination offset.",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "List the last 10 completed trajectories." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Found N trajectory record(s)...",
          action: "QUERY_TRAJECTORIES",
        },
      },
    ],
  ],
};
