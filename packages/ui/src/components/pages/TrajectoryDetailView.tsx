/**
 * Trajectory detail view: loads one recorded agent-run trajectory by id and
 * renders its pipeline stages, per-stage context diffs, and token deltas as a
 * stage-navigated inspector. Consumed by the Trajectories list surface when a
 * run is opened.
 */

import {
  Brain,
  CheckCircle,
  MessageSquare,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api/client";
import type {
  NativeToolCallEvent,
  TrajectoryCacheObservation,
  TrajectoryContextDiff,
  TrajectoryDetailResult,
  TrajectoryEvaluationEvent,
  TrajectoryEvent,
  TrajectoryLlmCall,
  TrajectoryProviderAccess,
} from "../../api/client-types-cloud";
import { useAppSelector } from "../../state";
import {
  formatTrajectoryDuration,
  formatTrajectoryTimestamp,
  formatTrajectoryTokenCount,
} from "../../utils/trajectory-format";
import { PagePanel } from "../composites/page-panel";
import {
  type TrajectoryCacheMetric,
  TrajectoryCacheStats,
} from "../composites/trajectories/trajectory-cache-stats";
import {
  TrajectoryContextDiffList,
  type TrajectoryContextDiffSummary,
} from "../composites/trajectories/trajectory-context-diff-list";
import {
  TrajectoryEventTimeline,
  type TrajectoryTimelineEvent,
} from "../composites/trajectories/trajectory-event-timeline";
import { TrajectoryLlmCallCard } from "../composites/trajectories/trajectory-llm-call-card";
import {
  type PipelineNode,
  type PipelineStageId,
  TrajectoryPipelineGraph,
} from "../composites/trajectories/trajectory-pipeline-graph";
import { ToolCallEventLog } from "../tool-events/ToolCallEventLog";
import {
  getToolCallEventDisplayState,
  getToolCallName,
} from "../tool-events/ToolCallEventLog.helpers";
import { Button } from "../ui/button";

// ---------------------------------------------------------------------------
// Pipeline stage mapping
// ---------------------------------------------------------------------------

const STEP_TYPE_TO_STAGE: Record<string, PipelineStageId> = {
  should_respond: "should_respond",
  compose_state: "plan",
  response: "plan",
  reasoning: "plan",
  orchestrator: "plan",
  coordination: "plan",
  action: "actions",
  evaluation: "evaluators",
  observation_extraction: "evaluators",
  turn_complete: "evaluators",
};

function stageForCall(call: TrajectoryLlmCall): PipelineStageId {
  return STEP_TYPE_TO_STAGE[call.stepType ?? ""] ?? "plan";
}

const PIPELINE_STAGES: Array<{
  id: PipelineStageId;
  label: string;
  icon: typeof Brain;
}> = [
  { id: "input", label: "Input", icon: MessageSquare },
  { id: "should_respond", label: "Should Respond", icon: ShieldCheck },
  { id: "plan", label: "Plan", icon: Brain },
  { id: "actions", label: "Actions", icon: Zap },
  { id: "evaluators", label: "Evaluators", icon: CheckCircle },
];

function buildPipelineNodes(
  llmCalls: TrajectoryLlmCall[],
  trajectoryStatus: string,
): PipelineNode[] {
  const counts = new Map<PipelineStageId, number>();
  for (const call of llmCalls) {
    const stage = stageForCall(call);
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }

  return PIPELINE_STAGES.map(({ id, label, icon }) => {
    const count = counts.get(id) ?? 0;
    const status: PipelineNode["status"] =
      id === "input"
        ? "active"
        : trajectoryStatus === "error" && count > 0
          ? "error"
          : count > 0
            ? "active"
            : "skipped";
    return { id, label, callCount: count, status, icon };
  });
}

interface TrajectoryDetailViewProps {
  trajectoryId: string;
}

function formatTrajectoryStepLabel(
  value: string | undefined,
  fallback: string,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return fallback;
  return normalized.replace(/_/g, " ");
}

function formatProviderPayload(value: unknown): string {
  if (value == null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // error-policy:J4 a cyclic or non-serializable recorded payload is an
    // expected trajectory shape; degrade to its printable form rather than
    // blanking the inspector.
    return String(value);
  }
}

/**
 * Recorded trajectory payloads arrive as parsed JSON, so an object candidate is
 * either an array or a plain record. Anything else (a Date, a class instance a
 * caller passed directly) keeps its own printable form and is never treated as
 * an empty record.
 */
function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A candidate carries content only when it would render something a reader can
 * inspect. Whitespace-only strings and empty collections are blank in the UI,
 * so they must not shadow a later populated candidate. Falsy scalars such as
 * `0` and `false` are real recorded values and stay renderable.
 */
function hasRenderableContent(candidate: unknown): boolean {
  if (candidate == null) return false;
  if (typeof candidate === "string") return candidate.trim().length > 0;
  if (Array.isArray(candidate)) return candidate.length > 0;
  if (typeof candidate === "object" && isPlainRecord(candidate)) {
    // A serialized-but-empty payload renders as the literal `{}`; that is the
    // same untruthful blank as `""` and must not shadow a populated fallback.
    return Object.keys(candidate).length > 0;
  }
  return true;
}

/**
 * Trajectory records are intentionally append-only and may omit prompt fields
 * for provider failures, embeddings, or legacy rows. Normalize those sparse
 * records at the rendering boundary so one missing prompt cannot crash the
 * complete trajectory viewer. Structured fallbacks remain inspectable JSON.
 */
export function normalizeTrajectoryCallText(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (!hasRenderableContent(candidate)) continue;
    return formatProviderPayload(candidate);
  }
  return "";
}

/**
 * Line count for a normalized trajectory field. Absent text has zero lines;
 * `"".split("\n").length` would otherwise report a fabricated single line in
 * the badge next to an empty panel.
 */
export function countTrajectoryTextLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

export interface TrajectoryCallText {
  systemPromptText: string;
  inputText: string;
  outputText: string;
}

/**
 * The single place a recorded call becomes the three panels the card renders.
 * The line badges are derived from exactly these strings, so a panel can never
 * disagree with the count printed beside it.
 */
export function buildTrajectoryCallText(
  call: Pick<
    TrajectoryLlmCall,
    | "systemPrompt"
    | "userPrompt"
    | "prompt"
    | "messages"
    | "response"
    | "output"
  >,
): TrajectoryCallText {
  return {
    systemPromptText: normalizeTrajectoryCallText(call.systemPrompt),
    inputText: normalizeTrajectoryCallText(
      call.userPrompt,
      call.prompt,
      call.messages,
    ),
    outputText: normalizeTrajectoryCallText(call.response, call.output),
  };
}

function isNativeToolCallEvent(
  event: TrajectoryEvent,
): event is NativeToolCallEvent {
  return (
    event.type === "tool_call" ||
    event.type === "tool_result" ||
    event.type === "tool_error"
  );
}

function isEvaluationEvent(
  event: TrajectoryEvent,
): event is TrajectoryEvaluationEvent {
  return event.type === "evaluation" || event.type === "evaluator";
}

function isCacheObservation(
  event: TrajectoryEvent,
): event is TrajectoryCacheObservation {
  return event.type === "cache_observation" || event.type === "cache";
}

function isContextDiff(event: TrajectoryEvent): event is TrajectoryContextDiff {
  return event.type === "context_diff";
}

function formatEventTimestamp(
  timestamp?: number,
  createdAt?: string,
): string | undefined {
  const value =
    typeof timestamp === "number" && Number.isFinite(timestamp)
      ? timestamp
      : createdAt
        ? Date.parse(createdAt)
        : Number.NaN;
  if (!Number.isFinite(value)) return undefined;
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function eventSortValue(event: { timestamp?: number; createdAt?: string }) {
  if (typeof event.timestamp === "number" && Number.isFinite(event.timestamp)) {
    return event.timestamp;
  }
  if (event.createdAt) {
    const parsed = Date.parse(event.createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.POSITIVE_INFINITY;
}

function timelineStatusForEvent(
  event: TrajectoryEvent,
): TrajectoryTimelineEvent["status"] {
  if (isNativeToolCallEvent(event)) {
    const state = getToolCallEventDisplayState(event);
    if (state === "failure") return "failure";
    if (state === "success") return "success";
    return "running";
  }

  const statusValue = (event as Record<string, unknown>).status;
  const status =
    typeof statusValue === "string" ? statusValue.toLowerCase() : "";
  if (status === "failed" || status === "error") return "failure";
  if (status === "completed" || status === "success") return "success";
  if (status === "running" || status === "queued") return "running";
  if (status === "skipped") return "skipped";
  return "info";
}

function labelForEvent(event: TrajectoryEvent): string {
  if (isNativeToolCallEvent(event)) return getToolCallName(event);
  if (isEvaluationEvent(event)) {
    return event.evaluatorName || event.name || "evaluation";
  }
  if (isCacheObservation(event)) {
    return event.cacheName || event.scope || "cache";
  }
  if (isContextDiff(event)) return event.label || "context diff";
  return event.type.replace(/_/g, " ");
}

function descriptionForEvent(event: TrajectoryEvent): string | undefined {
  if (isNativeToolCallEvent(event)) {
    const args = event.args ?? event.input;
    return args ? formatProviderPayload(args) : undefined;
  }
  if (isEvaluationEvent(event)) {
    return event.thought || event.decision || event.error;
  }
  if (isCacheObservation(event)) {
    return `${event.hit ? "hit" : "miss"}${event.key ? ` - ${event.key}` : ""}`;
  }
  if (isContextDiff(event)) {
    return `${event.added ?? 0} added, ${event.removed ?? 0} removed, ${
      event.changed ?? 0
    } changed`;
  }
  return undefined;
}

function dedupeEvents<T extends { id?: string; type?: string }>(
  events: readonly T[],
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  events.forEach((event, index) => {
    const key = `${event.type ?? "event"}:${event.id ?? index}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(event);
  });
  return result;
}

function buildTimelineEvents(params: {
  events: readonly TrajectoryEvent[];
  llmCalls: readonly TrajectoryLlmCall[];
  providerAccesses: readonly TrajectoryProviderAccess[];
}): TrajectoryTimelineEvent[] {
  const explicitEvents = params.events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const diff = eventSortValue(a.event) - eventSortValue(b.event);
      return diff === 0 ? a.index - b.index : diff;
    });

  if (explicitEvents.length > 0) {
    return explicitEvents.map(({ event, index }) => ({
      id: event.id || `${event.type}-${index}`,
      type: event.type,
      label: labelForEvent(event),
      stage: event.stage ? String(event.stage).replace(/_/g, " ") : undefined,
      status: timelineStatusForEvent(event),
      timestampLabel: formatEventTimestamp(event.timestamp, event.createdAt),
      description: descriptionForEvent(event),
      meta: event.stepId,
    }));
  }

  return [
    ...params.llmCalls.map<TrajectoryTimelineEvent>((call, index) => ({
      id: call.id,
      type: "llm_call",
      label: formatTrajectoryStepLabel(
        call.stepType || call.purpose || call.actionType,
        `LLM call ${index + 1}`,
      ),
      stage: stageForCall(call).replace(/_/g, " "),
      status: "success",
      timestampLabel: formatEventTimestamp(call.timestamp, call.createdAt),
      description: call.model,
      meta: call.stepId,
    })),
    ...params.providerAccesses.map<TrajectoryTimelineEvent>((access) => ({
      id: access.id,
      type: "provider_access",
      label: access.providerName,
      stage: "provider",
      status: "success",
      timestampLabel: formatEventTimestamp(access.timestamp, access.createdAt),
      description: access.purpose,
      meta: access.stepId,
    })),
  ].sort((a, b) =>
    String(a.timestampLabel ?? "").localeCompare(
      String(b.timestampLabel ?? ""),
    ),
  );
}

function buildCacheMetrics(
  observations: readonly TrajectoryCacheObservation[],
  stats: TrajectoryDetailResult["cacheStats"] | undefined,
): TrajectoryCacheMetric[] {
  const total = stats?.total ?? observations.length;
  if (total === 0) return [];
  const hits =
    stats?.hits ?? observations.filter((observation) => observation.hit).length;
  const misses = stats?.misses ?? total - hits;
  const hitRate = stats?.hitRate ?? hits / Math.max(total, 1);
  const tokenCount =
    stats?.tokenCount ??
    observations.reduce((sum, observation) => {
      return sum + (observation.tokenCount ?? 0);
    }, 0);
  return [
    { id: "hits", label: "Hits", value: hits, meta: `${total} total` },
    { id: "misses", label: "Misses", value: misses },
    {
      id: "hit-rate",
      label: "Hit Rate",
      value: `${Math.round(hitRate * 100)}%`,
    },
    {
      id: "tokens",
      label: "Tokens",
      value: formatTrajectoryTokenCount(tokenCount, { emptyLabel: "—" }),
    },
  ];
}

function buildContextDiffSummaries(
  diffs: readonly TrajectoryContextDiff[],
): TrajectoryContextDiffSummary[] {
  return diffs.map((diff, index) => ({
    id: diff.id || `context-diff-${index}`,
    label: diff.label || `Context diff ${index + 1}`,
    timestampLabel: formatEventTimestamp(diff.timestamp, diff.createdAt),
    added: diff.added ?? 0,
    removed: diff.removed ?? 0,
    changed:
      diff.changed ??
      diff.changes?.filter((change) => change.type === "changed").length ??
      0,
    tokenDelta: diff.tokenDelta ?? "—",
    description:
      diff.beforeContextId || diff.afterContextId
        ? `${diff.beforeContextId ?? "before"} -> ${
            diff.afterContextId ?? "after"
          }`
        : undefined,
  }));
}

export function TrajectoryDetailView({
  trajectoryId,
}: TrajectoryDetailViewProps) {
  const t = useAppSelector((s) => s.t);
  const copyToClipboard = useAppSelector((s) => s.copyToClipboard);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<TrajectoryDetailResult | null>(null);
  const [error, setError] = useState<
    "missing" | "restricted" | "offline" | "error" | null
  >(null);
  const [activeStage, setActiveStage] = useState<PipelineStageId | null>(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.getTrajectoryDetail(trajectoryId);
      setDetail(result);
    } catch (err) {
      const candidate = err as { kind?: unknown; status?: unknown } | null;
      const status =
        typeof candidate?.status === "number" ? candidate.status : 0;
      const kind = typeof candidate?.kind === "string" ? candidate.kind : "";
      setError(
        status === 404
          ? "missing"
          : status === 401 || status === 403
            ? "restricted"
            : kind === "network" ||
                kind === "timeout" ||
                status === 202 ||
                status === 502 ||
                status === 503 ||
                status === 504
              ? "offline"
              : "error",
      );
    } finally {
      setLoading(false);
    }
  }, [trajectoryId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const llmCalls = detail?.llmCalls ?? [];
  const providerAccesses = detail?.providerAccesses ?? [];
  const trajectory = detail?.trajectory;
  // The whole event pipeline (several O(n) dedupeEvents + the O(n log n)
  // buildTimelineEvents + cache/context derivations) was rebuilt in the render
  // body on EVERY render — filter clicks, hover, any state change — over a
  // trajectory that can carry hundreds of events. Memoize it on the fetched
  // detail so it only recomputes when the data actually changes.
  const {
    toolEvents,
    timelineEvents,
    cacheMetrics,
    contextDiffSummaries,
    shouldShowNativeEventPanels,
  } = useMemo(() => {
    const explicitEvents = detail?.events ?? [];
    const toolEvents = dedupeEvents([
      ...(detail?.toolEvents ?? []),
      ...explicitEvents.filter(isNativeToolCallEvent),
    ]);
    const evaluationEvents = dedupeEvents([
      ...(detail?.evaluationEvents ?? []),
      ...explicitEvents.filter(isEvaluationEvent),
    ]);
    const cacheObservations = dedupeEvents([
      ...(detail?.cacheObservations ?? []),
      ...explicitEvents.filter(isCacheObservation),
    ]);
    const contextDiffs = dedupeEvents([
      ...(detail?.contextDiffs ?? []),
      ...explicitEvents.filter(isContextDiff),
    ]);
    const timelineEvents = buildTimelineEvents({
      events: dedupeEvents([
        ...explicitEvents,
        ...toolEvents,
        ...evaluationEvents,
        ...cacheObservations,
        ...contextDiffs,
      ]),
      llmCalls,
      providerAccesses,
    });
    const cacheMetrics = buildCacheMetrics(
      cacheObservations,
      detail?.cacheStats,
    );
    const contextDiffSummaries = buildContextDiffSummaries(contextDiffs);
    const shouldShowNativeEventPanels =
      explicitEvents.length > 0 ||
      toolEvents.length > 0 ||
      evaluationEvents.length > 0 ||
      cacheObservations.length > 0 ||
      Boolean(detail?.cacheStats) ||
      contextDiffs.length > 0 ||
      (detail?.contextEvents?.length ?? 0) > 0;
    return {
      explicitEvents,
      toolEvents,
      evaluationEvents,
      cacheObservations,
      contextDiffs,
      timelineEvents,
      cacheMetrics,
      contextDiffSummaries,
      shouldShowNativeEventPanels,
    };
  }, [detail, llmCalls, providerAccesses]);

  const pipelineNodes = useMemo(
    () => buildPipelineNodes(llmCalls, trajectory?.status ?? "active"),
    [llmCalls, trajectory?.status],
  );

  const filteredCalls = useMemo(() => {
    if (!activeStage || activeStage === "input") return llmCalls;
    return llmCalls.filter((call) => stageForCall(call) === activeStage);
  }, [llmCalls, activeStage]);

  const callIndexMap = useMemo(
    () => new Map(llmCalls.map((call, i) => [call.id, i])),
    [llmCalls],
  );

  const handleStageClick = useCallback((stageId: PipelineStageId) => {
    setActiveStage((prev) =>
      prev === stageId || stageId === "input" ? null : stageId,
    );
  }, []);

  const clearStageFilter = useAgentElement<HTMLButtonElement>({
    id: "clear-stage-filter",
    role: "button",
    label: "Clear pipeline stage filter",
    group: "trajectory-pipeline",
    description:
      "Reset the active pipeline stage filter and show all LLM calls",
    onActivate: () => setActiveStage(null),
  });

  if (loading) {
    return (
      <div className="overflow-hidden rounded-[16px] border border-[color:var(--settings-hairline)] bg-[var(--settings-panel)]">
        <PagePanel.ContentState
          state="loading"
          placement="workspace"
          className="min-h-[24rem]"
          heading={t("trajectorydetailview.LoadingTrajectory")}
          description={t("trajectorydetailview.LoadingDescription")}
        />
      </div>
    );
  }

  if (error) {
    const copy =
      error === "missing"
        ? {
            title: "Trajectory unavailable",
            description: "This recorded run may have been removed.",
          }
        : error === "restricted"
          ? {
              title: "Trajectory restricted",
              description: "This account can't inspect the selected run.",
            }
          : error === "offline"
            ? {
                title: "Agent unavailable",
                description: "Reconnect to inspect this recorded run.",
              }
            : {
                title: "Couldn't load this run",
                description: "Try again in a moment.",
              };
    return (
      <div className="overflow-hidden rounded-[16px] border border-[color:var(--settings-hairline)] bg-[var(--settings-panel)]">
        <PagePanel.ContentState
          state="error"
          placement="workspace"
          tone="warning"
          role="status"
          className="min-h-[24rem]"
          title={copy.title}
          description={copy.description}
          action={
            error === "missing" || error === "restricted" ? undefined : (
              <Button
                type="button"
                size="touch"
                variant="outline"
                onClick={() => void loadDetail()}
              >
                Retry
              </Button>
            )
          }
        />
      </div>
    );
  }

  if (!detail || !trajectory) {
    return (
      <div className="overflow-hidden rounded-[16px] border border-[color:var(--settings-hairline)] bg-[var(--settings-panel)]">
        <PagePanel.ContentState
          state="error"
          placement="workspace"
          tone="warning"
          role="status"
          className="min-h-[24rem]"
          title={t("trajectorydetailview.Unavailable")}
          description={t("trajectorydetailview.TrajectoryNotFound")}
        />
      </div>
    );
  }

  const orchestrator = trajectory.metadata?.orchestrator;
  const orchestratorData =
    orchestrator && typeof orchestrator === "object"
      ? (orchestrator as Record<string, unknown>)
      : null;

  return (
    <div className="flex min-h-0 flex-col gap-6">
      <section>
        <div className="flex min-h-16 items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[17px] font-semibold text-[color:var(--settings-foreground)]">
              {formatTrajectoryTimestamp(trajectory.createdAt, "smart")}
            </h2>
            <p className="truncate text-[13px] leading-5 text-[color:var(--settings-muted)]">
              {trajectory.source}
              {trajectory.scenarioId ? ` / ${trajectory.scenarioId}` : ""}
            </p>
          </div>
          <span className="inline-flex min-h-7 shrink-0 items-center rounded-full bg-[var(--settings-fill)] px-3 text-xs font-medium capitalize text-[color:var(--settings-muted)]">
            {trajectory.status}
          </span>
        </div>
        <dl className="grid grid-cols-2 border-y border-[color:var(--settings-hairline)] min-[620px]:grid-cols-4">
          {[
            {
              label: "Duration",
              value: formatTrajectoryDuration(trajectory.durationMs),
            },
            { label: "Model calls", value: trajectory.llmCallCount },
            {
              label: "Tokens",
              value: formatTrajectoryTokenCount(
                trajectory.totalPromptTokens + trajectory.totalCompletionTokens,
                { emptyLabel: "0" },
              ),
            },
            { label: "Provider reads", value: trajectory.providerAccessCount },
          ].map((metric) => (
            <div
              key={metric.label}
              className="border-b border-[color:var(--settings-hairline)] px-3 py-3 first:pl-0 odd:border-r min-[620px]:border-b-0 min-[620px]:border-r min-[620px]:last:border-r-0 min-[620px]:last:pr-0"
            >
              <dt className="text-xs text-[color:var(--settings-muted)]">
                {metric.label}
              </dt>
              <dd className="mt-1 text-sm font-semibold text-[color:var(--settings-foreground)]">
                {metric.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      {orchestratorData ? (
        <section>
          <h3 className="mb-3 text-sm font-semibold text-[color:var(--settings-foreground)]">
            Orchestration
          </h3>
          <dl className="divide-y divide-[color:var(--settings-hairline)] border-y border-[color:var(--settings-hairline)]">
            {[
              {
                label: t("trajectorydetailview.DecisionType"),
                value: String(orchestratorData.decisionType ?? "Not recorded"),
              },
              {
                label: t("trajectorydetailview.Task"),
                value: String(orchestratorData.taskLabel ?? "Not recorded"),
              },
              {
                label: t("trajectorydetailview.Session1"),
                value: String(orchestratorData.sessionId ?? "Not recorded"),
              },
            ].map((item) => (
              <div
                key={item.label}
                className="flex min-h-12 items-start justify-between gap-4 py-3 text-sm"
              >
                <dt className="text-[color:var(--settings-muted)]">
                  {item.label}
                </dt>
                <dd className="min-w-0 max-w-[65%] break-words text-right font-medium text-[color:var(--settings-foreground)]">
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {trajectory.metadata &&
      Object.keys(trajectory.metadata).length > 0 &&
      formatProviderPayload(trajectory.metadata).trim().length > 0 ? (
        <details className="group border-y border-[color:var(--settings-hairline)]">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between py-3 text-sm font-medium text-[color:var(--settings-foreground)] hover:text-primary">
            Run metadata
            <span className="text-xs text-[color:var(--settings-muted)] group-open:hidden">
              Show
            </span>
            <span className="hidden text-xs text-[color:var(--settings-muted)] group-open:inline">
              Hide
            </span>
          </summary>
          <pre className="max-h-[20rem] overflow-auto whitespace-pre-wrap break-words border-t border-[color:var(--settings-hairline)] py-4 text-xs leading-6 text-[color:var(--settings-foreground)]">
            {formatProviderPayload(trajectory.metadata)}
          </pre>
        </details>
      ) : null}

      {llmCalls.length > 0 ? (
        <section>
          <h3 className="mb-3 text-sm font-semibold text-[color:var(--settings-foreground)]">
            Pipeline
          </h3>
          <TrajectoryPipelineGraph
            nodes={pipelineNodes}
            activeStageId={activeStage}
            onStageClick={handleStageClick}
          />
          {activeStage && activeStage !== "input" ? (
            <div className="mt-3 flex min-h-11 items-center gap-2 text-xs text-[color:var(--settings-muted)]">
              <span>
                {t("trajectorydetailview.ShowingCalls", {
                  defaultValue: "Showing {{count}} {{stage}} calls",
                  count: filteredCalls.length,
                  stage: activeStage.replace(/_/g, " "),
                })}
              </span>
              <Button
                ref={clearStageFilter.ref}
                onClick={() => setActiveStage(null)}
                variant="ghostMuted"
                size="icon-lg"
                aria-label="Clear stage filter"
                {...clearStageFilter.agentProps}
              >
                <X className="size-3" />
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      <TrajectoryEventTimeline
        heading={t("trajectorydetailview.EventTimeline", {
          defaultValue: "Event Timeline",
        })}
        emptyLabel={t("trajectorydetailview.NoEventsCaptured", {
          defaultValue: "No events captured",
        })}
        events={timelineEvents}
      />

      {toolEvents.length > 0 ? (
        <section>
          <h3 className="mb-3 text-sm font-semibold text-[color:var(--settings-foreground)]">
            Tool activity
          </h3>
          <div className="space-y-3">
            {toolEvents.map((event, index) => (
              <ToolCallEventLog
                event={event}
                key={event.id || `${event.type}-${index}`}
              />
            ))}
          </div>
        </section>
      ) : null}

      {shouldShowNativeEventPanels ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <TrajectoryCacheStats
            heading={t("trajectorydetailview.CacheStats", {
              defaultValue: "Cache Stats",
            })}
            emptyLabel={t("trajectorydetailview.NoCacheObservations", {
              defaultValue: "No cache observations captured",
            })}
            metrics={cacheMetrics}
          />
          <TrajectoryContextDiffList
            heading={t("trajectorydetailview.ContextDiffs", {
              defaultValue: "Context Diffs",
            })}
            emptyLabel={t("trajectorydetailview.NoContextDiffs", {
              defaultValue:
                "Context diffs are not available for this trajectory",
            })}
            diffs={contextDiffSummaries}
          />
        </div>
      ) : null}

      {providerAccesses.length > 0 ? (
        <section>
          <h3 className="mb-3 text-sm font-semibold text-[color:var(--settings-foreground)]">
            Provider activity
          </h3>
          <div className="divide-y divide-[color:var(--settings-hairline)] border-y border-[color:var(--settings-hairline)]">
            {providerAccesses.map((access, index) => (
              <details key={access.id} className="group overflow-hidden">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-[color:var(--settings-foreground)]">
                      {access.providerName || "Unknown provider"}
                    </span>
                    <span className="block truncate text-xs text-[color:var(--settings-muted)]">
                      {access.purpose ||
                        t("trajectorydetailview.ProviderAccess", {
                          defaultValue: "Provider access",
                        })}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-[color:var(--settings-muted)] group-open:hidden">
                    #{index + 1} Show
                  </span>
                  <span className="hidden shrink-0 text-xs text-[color:var(--settings-muted)] group-open:inline">
                    Hide
                  </span>
                </summary>
                <div className="border-t border-[color:var(--settings-hairline)] py-4">
                  {access.query ? (
                    <div>
                      <div className="text-xs font-medium text-[color:var(--settings-muted)]">
                        {t("trajectorydetailview.Query", {
                          defaultValue: "Query",
                        })}
                      </div>
                      <pre className="mt-2 max-h-[18rem] overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-[var(--settings-panel)] p-4 text-xs leading-6 text-[color:var(--settings-foreground)]">
                        {formatProviderPayload(access.query)}
                      </pre>
                    </div>
                  ) : null}
                  <div className={access.query ? "mt-4" : ""}>
                    <div className="text-xs font-medium text-[color:var(--settings-muted)]">
                      {t("trajectorydetailview.Data", {
                        defaultValue: "Data",
                      })}
                    </div>
                    <pre className="mt-2 max-h-[18rem] overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-[var(--settings-panel)] p-4 text-xs leading-6 text-[color:var(--settings-foreground)]">
                      {formatProviderPayload(access.data)}
                    </pre>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </section>
      ) : null}

      <div className="min-h-0 flex-1">
        <div className="space-y-4 pb-1">
          {llmCalls.length === 0 ? (
            <PagePanel.Empty
              variant="surface"
              className="min-h-[18rem]"
              title={t("trajectorydetailview.NoCapturedCalls")}
              description={t("trajectorydetailview.NoLLMCallsRecorde")}
            />
          ) : (
            filteredCalls.map((call) => {
              const { systemPromptText, inputText, outputText } =
                buildTrajectoryCallText(call);
              const linesLabel = t("trajectorydetailview.lines");
              return (
                <TrajectoryLlmCallCard
                  key={call.id}
                  callLabel={`#${(callIndexMap.get(call.id) ?? 0) + 1}`}
                  model={call.model}
                  purposeLabel={formatTrajectoryStepLabel(
                    call.stepType || call.purpose || call.actionType,
                    t("trajectorydetailview.Response"),
                  )}
                  latencyLabel={t("trajectorydetailview.Latency", {
                    defaultValue: "Latency",
                  })}
                  latencyValue={formatTrajectoryDuration(call.latencyMs)}
                  tokensLabel={t("common.tokens")}
                  totalTokensValue={formatTrajectoryTokenCount(
                    (call.promptTokens ?? 0) + (call.completionTokens ?? 0),
                    { emptyLabel: "—" },
                  )}
                  tokenBreakdownMeta={`${formatTrajectoryTokenCount(
                    call.promptTokens ?? 0,
                    { emptyLabel: "—" },
                  )}↑ • ${formatTrajectoryTokenCount(
                    call.completionTokens ?? 0,
                    {
                      emptyLabel: "—",
                    },
                  )} ↓`}
                  temperatureLabel={t("trajectorydetailview.Temp")}
                  temperatureValue={call.temperature}
                  maxLabel={t("trajectorydetailview.Max")}
                  maxValue={call.maxTokens > 0 ? call.maxTokens : "—"}
                  systemPrompt={
                    systemPromptText.length > 0 ? systemPromptText : null
                  }
                  systemPromptButtonLabel={t(
                    "trajectorydetailview.SystemPrompt",
                  )}
                  systemLabel={t("trajectorydetailview.System")}
                  systemLinesLabel={`${countTrajectoryTextLines(
                    systemPromptText,
                  )} ${linesLabel}`}
                  systemCollapseLabel={t("common.collapse", {
                    defaultValue: "Collapse",
                  })}
                  systemExpandLabel={t("common.expand", {
                    defaultValue: "Expand",
                  })}
                  inputLabel={t("trajectorydetailview.InputUser")}
                  outputLabel={t("trajectorydetailview.OutputResponse")}
                  inputLinesLabel={`${countTrajectoryTextLines(
                    inputText,
                  )} ${linesLabel}`}
                  outputLinesLabel={`${countTrajectoryTextLines(
                    outputText,
                  )} ${linesLabel}`}
                  tags={(call.tags ?? []).filter((tag) => tag !== "llm")}
                  userPrompt={inputText}
                  response={outputText}
                  copyLabel={t("trajectorydetailview.Copy")}
                  copyToClipboardLabel={t(
                    "trajectorydetailview.CopyToClipboard",
                  )}
                  onCopy={(content) => {
                    void copyToClipboard(content);
                  }}
                />
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
