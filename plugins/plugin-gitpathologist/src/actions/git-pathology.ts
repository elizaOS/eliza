/**
 * GIT_PATHOLOGY action — single multiplex Action that dispatches to the
 * GitPathologyService. Pattern mirrors plugin-agent-orchestrator's TASKS.
 *
 * Actions:
 *   report (default) — full pathology report for a surface
 *   list             — list cached reports for the repo root
 *   trace/diff       — legacy v2 placeholders retained as explicit errors
 */

import path from "node:path";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { renderReport } from "../render.ts";
import {
  GIT_PATHOLOGY_SERVICE_NAME,
  type GitPathologyService,
} from "../services/git-pathology-service.ts";
import type { AnalysisOptions, Operation, PathologyReport, SurfaceSpec } from "../types.ts";

type GitPathologyOperation = Operation | "trace" | "diff";

const VALID_ACTIONS: ReadonlySet<GitPathologyOperation> = new Set([
  "report",
  "list",
  "trace",
  "diff",
]);
const SURFACE_HINT_RE =
  /\b(pathology|git\s+history|code\s+health|drift|rot|inflection|when\s+did\s+(?:this\s+)?(?:code|file|module|package|plugin|service|component|path|repo|repository|branch|commit))\b/i;

function getService(runtime: IAgentRuntime): GitPathologyService | null {
  return runtime.getService<GitPathologyService>(GIT_PATHOLOGY_SERVICE_NAME) ?? null;
}

function paramsRecord(
  options: HandlerOptions | Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const parameters = (options as HandlerOptions).parameters;
  if (parameters && typeof parameters === "object") {
    return parameters as Record<string, unknown>;
  }
  const params = (options as Record<string, unknown>).params;
  if (params && typeof params === "object") return params as Record<string, unknown>;
  return options as Record<string, unknown>;
}

function readAction(params: Record<string, unknown>): GitPathologyOperation {
  const rawValue =
    params.action ?? params.operation ?? params.op ?? params.subaction;
  const raw = typeof rawValue === "string" ? rawValue.toLowerCase() : "report";
  return VALID_ACTIONS.has(raw as GitPathologyOperation)
    ? (raw as GitPathologyOperation)
    : "report";
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function readNumber(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const parsed = Number.parseInt(v, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function buildOptions(params: Record<string, unknown>): Partial<AnalysisOptions> {
  const out: Partial<AnalysisOptions> = {};
  const since = readString(params, "since");
  if (since) out.since = since;
  const budget = readNumber(params, "budget");
  if (typeof budget === "number") out.budget = budget;
  const cache = readString(params, "cache");
  if (cache === "auto" || cache === "force" || cache === "read-only") out.cache = cache;
  return out;
}

function resolveRepoRoot(): string {
  const fromEnv = process.env.MILADY_WORKSPACE_DIR ?? process.env.ELIZA_WORKSPACE_DIR;
  const cwd = fromEnv?.trim() ? fromEnv.trim() : process.cwd();
  return path.resolve(cwd);
}

function listResult(service: GitPathologyService, repoRoot: string): ActionResult {
  const summaries = service.listReports(repoRoot);
  if (summaries.length === 0) {
    return {
      success: true,
      text: "No cached pathology reports for this repo yet.",
      data: { reports: [] },
    };
  }
  const lines = summaries.map(
    (s) =>
      `- ${s.surface} (${s.commitCount} commits) — HEAD ${s.headSha.slice(0, 7)}, generated ${s.generatedAt}`
  );
  return {
    success: true,
    text: `Cached pathology reports:\n${lines.join("\n")}`,
    data: { reports: summaries },
  };
}

function notImplementedResult(operation: GitPathologyOperation): ActionResult {
  const text = `Operation "${operation}" is not implemented in gitpathologist v1. Use action="report" or action="list".`;
  return { success: false, text, error: "NOT_IMPLEMENTED" };
}

function reportResult(report: PathologyReport): ActionResult {
  return {
    success: true,
    text: renderReport(report),
    data: { report },
  };
}

export const gitPathologyAction: Action & { suppressPostActionContinuation: true } = {
  name: "GIT_PATHOLOGY",
  similes: [
    "ANALYZE_GIT_PATHOLOGY",
    "GIT_HEALTH",
    "GIT_FORENSICS",
    "PATHOLOGY_REPORT",
    "CODE_HISTORY_HEALTH",
    "WHERE_DID_ROT_START",
  ],
  description:
    "Forensic git-history analysis for a path/glob surface. Returns peaks (peak quality moments), drift inflections (where rot started), and a post-mortem narrative. Use when the user asks 'when did this code get bad', 'where did rot start in X', or 'analyze git pathology for Y'. Actions: report (default), list (show cached reports).",
  contexts: ["code", "git", "general"],
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "action",
      description: "Which gitpathologist action: report or list. Default: report.",
      required: false,
      schema: { type: "string" as const, enum: ["report", "list"] },
    },
    {
      name: "surface",
      description: "Path or glob to analyze (relative to repo root). Required for action=report.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "since",
      description: "Lookback window. ISO date or relative (e.g. '14d', '4w'). Default '14d'.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "budget",
      description: "Max LLM narration calls per analysis. Default 20.",
      required: false,
      schema: { type: "integer" as const, minimum: 0 },
    },
    {
      name: "cache",
      description: "Cache policy: auto (default), force (recompute), read-only (fail on miss).",
      required: false,
      schema: { type: "string" as const, enum: ["auto", "force", "read-only"] },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    if (!getService(runtime)) return false;
    const content = message.content as { text?: unknown; params?: unknown };
    const params =
      content.params && typeof content.params === "object"
        ? (content.params as Record<string, unknown>)
        : null;
    if (
      params &&
      (typeof params.action === "string" ||
        typeof params.operation === "string" ||
        typeof params.op === "string" ||
        typeof params.subaction === "string")
    ) {
      return true;
    }
    if (params && typeof params.surface === "string") return true;
    const text = typeof content.text === "string" ? content.text : "";
    return SURFACE_HINT_RE.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = getService(runtime);
    if (!service) {
      const text = "GitPathologyService not registered on runtime.";
      return { success: false, text, error: "SERVICE_UNAVAILABLE" };
    }
    const params = paramsRecord(options);
    const action = readAction(params);
    const repoRoot = resolveRepoRoot();

    if (action === "list") {
      const result = listResult(service, repoRoot);
      if (callback && typeof result.text === "string") {
        await callback({ text: result.text });
      }
      return result;
    }

    if (action === "trace" || action === "diff") {
      const result = notImplementedResult(action);
      if (callback && typeof result.text === "string") {
        await callback({ text: result.text });
      }
      return result;
    }

    const surfacePath = readString(params, "surface");
    if (!surfacePath) {
      const text = "action=report requires a `surface` param (path or glob relative to repo root).";
      if (callback) await callback({ text });
      return { success: false, text, error: "MISSING_SURFACE" };
    }
    const surface: SurfaceSpec = { path: surfacePath, repoRoot };
    const overrides = buildOptions(params);

    let report: PathologyReport;
    try {
      report = await service.runReport(surface, overrides);
    } catch (err) {
      const text = `Git pathology analysis failed: ${(err as Error).message}`;
      if (callback) await callback({ text });
      return { success: false, text, error: "ANALYSIS_FAILED" };
    }
    const result = reportResult(report);
    if (callback && typeof result.text === "string") {
      await callback({ text: result.text });
    }
    return result;
  },
};
