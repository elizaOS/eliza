/**
 * Trajectory introspection actions.
 *
 * QUERY_TRAJECTORIES        → GET /api/trajectories
 * EXPORT_TRAJECTORY_DATASET → POST /api/trajectories/export
 * ANNOTATE_TRAJECTORY       → wraps annotateActiveTrajectoryStep utility
 */

import type { Action, ActionResult, HandlerOptions } from "@elizaos/core";
import { annotateActiveTrajectoryStep, logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";
import type {
  TrajectoryListResult,
  TrajectoryStepKind,
} from "../types/trajectory.js";

function getApiBase(): string {
  return `http://localhost:${resolveServerOnlyPort(process.env)}`;
}

const TRAJECTORY_STATUSES = ["active", "completed", "error"] as const;
type TrajectoryStatus = (typeof TRAJECTORY_STATUSES)[number];

const EXPORT_FORMATS = ["json", "jsonl", "csv", "art", "zip"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

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
  contexts: ["agent_internal", "admin", "knowledge"],
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

// ---------------------------------------------------------------------------
// EXPORT_TRAJECTORY_DATASET
// ---------------------------------------------------------------------------

interface ExportTrajectoriesFilter {
  source?: string;
  status?: TrajectoryStatus;
  scenarioId?: string;
  batchId?: string;
  startDate?: string;
  endDate?: string;
}

interface ExportTrajectoriesParams {
  format?: ExportFormat;
  includePrompts?: boolean;
  filter?: ExportTrajectoriesFilter;
}

export const exportTrajectoryDatasetAction: Action = {
  name: "EXPORT_TRAJECTORY_DATASET",
  contexts: ["agent_internal", "admin", "knowledge", "files"],
  roleGate: { minRole: "OWNER" },
  similes: ["DUMP_TRAJECTORIES", "DOWNLOAD_TRAJECTORIES"],
  description:
    "Export trajectory data as JSON, JSONL, CSV, ART, or ZIP via /api/trajectories/export. Returns the response size; the agent does not stream the bytes back to the user.",
  descriptionCompressed:
    "export trajectory data JSON, JSONL, CSV, ART, ZIP via / api/trajectories/export return response size; agent stream byte back user",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | ExportTrajectoriesParams
      | undefined;
    const format: ExportFormat = EXPORT_FORMATS.includes(
      params?.format as ExportFormat,
    )
      ? (params?.format as ExportFormat)
      : "json";

    const body: Record<string, unknown> = {
      format,
      includePrompts: params?.includePrompts === true,
    };
    if (params?.filter) {
      const filter = params.filter;
      if (filter.source) body.source = filter.source;
      if (filter.status && TRAJECTORY_STATUSES.includes(filter.status)) {
        body.status = filter.status;
      }
      if (filter.scenarioId) body.scenarioId = filter.scenarioId;
      if (filter.batchId) body.batchId = filter.batchId;
      if (filter.startDate) body.startDate = filter.startDate;
      if (filter.endDate) body.endDate = filter.endDate;
    }

    try {
      const resp = await fetch(`${getApiBase()}/api/trajectories/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) {
        return {
          success: false,
          text: `Export failed: HTTP ${resp.status}`,
        };
      }
      const buffer = await resp.arrayBuffer();
      const sizeBytes = buffer.byteLength;
      return {
        success: true,
        text: `Exported trajectory dataset as ${format} (${sizeBytes} bytes).`,
        values: { format, sizeBytes },
        data: {
          actionName: "EXPORT_TRAJECTORY_DATASET",
          format,
          sizeBytes,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[export-trajectory-dataset] failed: ${msg}`);
      return { success: false, text: `Export failed: ${msg}` };
    }
  },
  parameters: [
    {
      name: "format",
      description: "Export format: json, csv, or zip.",
      required: true,
      schema: { type: "string" as const, enum: [...EXPORT_FORMATS] },
    },
    {
      name: "includePrompts",
      description: "Whether to include full prompt text in the export.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "filter",
      description:
        "Optional filter object with the same shape as QUERY_TRAJECTORIES (source/status/scenarioId/batchId/startDate/endDate).",
      required: false,
      schema: { type: "object" as const },
    },
  ],
  examples: [],
};

// ---------------------------------------------------------------------------
// ANNOTATE_TRAJECTORY
// ---------------------------------------------------------------------------

const TRAJECTORY_STEP_KINDS = [
  "llm",
  "action",
  "executeCode",
] as const satisfies readonly TrajectoryStepKind[];

interface AnnotateTrajectoryParams {
  stepId?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

function isStepKind(value: unknown): value is TrajectoryStepKind {
  return (
    typeof value === "string" &&
    (TRAJECTORY_STEP_KINDS as readonly string[]).includes(value)
  );
}

function readStringArrayField(
  metadata: Record<string, unknown> | undefined,
  field: string,
): string[] | undefined {
  if (!metadata) return undefined;
  const raw = metadata[field];
  if (!Array.isArray(raw)) return undefined;
  const filtered = raw.filter(
    (item): item is string => typeof item === "string",
  );
  return filtered.length === raw.length ? filtered : undefined;
}

function readStringField(
  metadata: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  if (!metadata) return undefined;
  const raw = metadata[field];
  return typeof raw === "string" ? raw : undefined;
}

export const annotateTrajectoryAction: Action = {
  name: "ANNOTATE_TRAJECTORY",
  contexts: ["agent_internal", "admin", "knowledge"],
  roleGate: { minRole: "OWNER" },
  similes: ["TAG_TRAJECTORY", "ANNOTATE_TRAJECTORY_STEP"],
  description:
    "Attach kind/script/childSteps/usedSkills annotations to the active trajectory step (or a supplied stepId).",
  descriptionCompressed:
    "attach kind/script/childsteps/usedskill annotation active trajectory step (suppli stepid)",
  validate: async () => true,
  handler: async (
    runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | AnnotateTrajectoryParams
      | undefined;

    const stepId = params?.stepId?.trim();
    if (!stepId) {
      return {
        success: false,
        text: "stepId is required.",
        values: { error: "MISSING_STEP_ID" },
      };
    }

    const kindRaw = params?.kind;
    const kind: TrajectoryStepKind | undefined = isStepKind(kindRaw)
      ? kindRaw
      : undefined;
    if (kindRaw !== undefined && kind === undefined) {
      return {
        success: false,
        text: `kind must be one of: ${TRAJECTORY_STEP_KINDS.join(", ")}.`,
        values: { error: "INVALID_KIND" },
      };
    }

    const metadata = params?.metadata ?? {};
    const script = readStringField(metadata, "script");
    const childSteps = readStringArrayField(metadata, "childSteps");
    const appendChildSteps = readStringArrayField(metadata, "appendChildSteps");
    const usedSkills = readStringArrayField(metadata, "usedSkills");

    try {
      const ok = await annotateActiveTrajectoryStep(runtime, {
        stepId,
        kind,
        script,
        childSteps,
        appendChildSteps,
        usedSkills,
      });
      if (!ok) {
        return {
          success: false,
          text: "Annotation skipped: no trajectory logger is registered or it is disabled.",
          values: { error: "LOGGER_UNAVAILABLE" },
        };
      }
      return {
        success: true,
        text: `Annotated trajectory step ${stepId}.`,
        values: { stepId },
        data: {
          actionName: "ANNOTATE_TRAJECTORY",
          stepId,
          kind,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[annotate-trajectory] failed: ${msg}`);
      return { success: false, text: `Failed to annotate trajectory: ${msg}` };
    }
  },
  parameters: [
    {
      name: "stepId",
      description: "ID of the trajectory step to annotate.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "kind",
      description: "Optional step kind (llm, action, executeCode).",
      required: false,
      schema: { type: "string" as const, enum: [...TRAJECTORY_STEP_KINDS] },
    },
    {
      name: "metadata",
      description:
        "Annotation metadata. Recognised keys: script (string), childSteps (string[]), appendChildSteps (string[]), usedSkills (string[]).",
      required: true,
      schema: { type: "object" as const },
    },
  ],
  examples: [],
};
