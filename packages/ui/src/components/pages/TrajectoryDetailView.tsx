import {
  Brain,
  CheckCircle,
  MessageSquare,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useApp } from "../../state/useApp";
import {
  formatTrajectoryDuration,
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
import { estimateTokenCost } from "../conversations/conversation-utils";
import {
  getToolCallEventDisplayState,
  getToolCallName,
  ToolCallEventLog,
} from "../tool-events/ToolCallEventLog";

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
  onBack?: () => void;
}

function formatTrajectoryStepLabel(
  value: string | undefined,
  fallback: string,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return fallback;
  return normalized.replace(/_/g, " ");
}

function estimateCost(
  promptTokens: number,
  completionTokens: number,
  model: string,
): string {
  return estimateTokenCost(promptTokens, completionTokens, model);
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
    return String(value);
  }
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
  const { t, copyToClipboard } = useApp();
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<TrajectoryDetailResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<PipelineStageId | null>(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.getTrajectoryDetail(trajectoryId);
      setDetail(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load trajectory",
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
  const cacheMetrics = buildCacheMetrics(cacheObservations, detail?.cacheStats);
  const contextDiffSummaries = buildContextDiffSummaries(contextDiffs);
  const shouldShowNativeEventPanels =
    explicitEvents.length > 0 ||
    toolEvents.length > 0 ||
    evaluationEvents.length > 0 ||
    cacheObservations.length > 0 ||
    Boolean(detail?.cacheStats) ||
    contextDiffs.length > 0 ||
    (detail?.contextEvents?.length ?? 0) > 0;

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

  if (loading) {
    return (
      <PagePanel.Loading
        variant="workspace"
        heading={t("trajectorydetailview.LoadingTrajectory")}
        description={t("trajectorydetailview.LoadingDescription")}
      />
    );
  }

  if (error) {
    return (
      <PagePanel.Empty
        variant="workspace"
        title={t("trajectorydetailview.UnableToLoad")}
        description={error}
      />
    );
  }

  if (!detail || !trajectory) {
    return (
      <PagePanel.Empty
        variant="workspace"
        title={t("trajectorydetailview.Unavailable")}
        description={t("trajectorydetailview.TrajectoryNotFound")}
      />
    );
  }

  const totalPromptTokens = llmCalls.reduce(
    (sum, call) => sum + (call.promptTokens ?? 0),
    0,
  );
  const totalCompletionTokens = llmCalls.reduce(
    (sum, call) => sum + (call.completionTokens ?? 0),
    0,
  );

  const orchestrator = trajectory.metadata?.orchestrator;
  const orchestratorData =
    orchestrator && typeof orchestrator === "object"
      ? (orchestrator as Record<string, unknown>)
      : null;

  const _summaryCards = [
    {
      label: t("logsview.Source"),
      value: trajectory.source,
    },
    {
      label: t("common.status"),
      value: trajectory.status,
    },
    {
      label: t("common.duration"),
      value: formatTrajectoryDuration(trajectory.durationMs),
    },
    {
      label: t("trajectorydetailview.TotalTokens", {
        defaultValue: "Total Tokens",
      }),
      value: formatTrajectoryTokenCount(
        totalPromptTokens + totalCompletionTokens,
        { emptyLabel: "—" },
      ),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {orchestratorData ? (
        <PagePanel variant="section" className="p-5">
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            {t("trajectorydetailview.Orchestrator")}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <PagePanel.SummaryCard compact className="px-4 py-3">
              <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
                {t("trajectorydetailview.DecisionType")}
              </div>
              <div className="mt-2 text-sm font-semibold text-txt">
                {String(orchestratorData.decisionType ?? "—")}
              </div>
            </PagePanel.SummaryCard>
            <PagePanel.SummaryCard compact className="px-4 py-3">
              <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
                {t("trajectorydetailview.Task")}
              </div>
              <div className="mt-2 text-sm font-semibold text-txt">
                {String(orchestratorData.taskLabel ?? "—")}
              </div>
            </PagePanel.SummaryCard>
            <PagePanel.SummaryCard compact className="px-4 py-3">
              <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
                {t("trajectorydetailview.Session1")}
              </div>
              <div className="mt-2 break-all font-mono text-xs-tight text-txt">
                {String(orchestratorData.sessionId ?? "—")}
              </div>
            </PagePanel.SummaryCard>
          </div>
        </PagePanel>
      ) : null}

      {trajectory.metadata &&
      Object.keys(trajectory.metadata).length > 0 &&
      formatProviderPayload(trajectory.metadata).trim().length > 0 ? (
        <PagePanel variant="section" className="p-5">
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            {t("trajectorydetailview.Metadata", {
              defaultValue: "Metadata",
            })}
          </div>
          <pre className="mt-4 max-h-[20rem] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words rounded-2xl border border-border/50 bg-bg/60 px-4 py-4 text-xs leading-6 text-txt">
            {formatProviderPayload(trajectory.metadata)}
          </pre>
        </PagePanel>
      ) : null}

      {llmCalls.length > 0 ? (
        <PagePanel variant="section" className="px-5 py-4">
          <div className="mb-3 text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            {t("trajectorydetailview.Pipeline", {
              defaultValue: "Pipeline",
            })}
          </div>
          <TrajectoryPipelineGraph
            nodes={pipelineNodes}
            activeStageId={activeStage}
            onStageClick={handleStageClick}
          />
          {activeStage && activeStage !== "input" ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted">
              <span>
                {t("trajectorydetailview.ShowingCalls", {
                  defaultValue: "Showing {{count}} {{stage}} calls",
                  count: filteredCalls.length,
                  stage: activeStage.replace(/_/g, " "),
                })}
              </span>
              <button
                type="button"
                onClick={() => setActiveStage(null)}
                className="rounded p-0.5 hover:bg-muted/10"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
        </PagePanel>
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
        <PagePanel variant="section" className="px-5 py-4">
          <div className="mb-3 text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            {t("trajectorydetailview.NativeToolEvents", {
              defaultValue: "Native Tool Events",
            })}
          </div>
          <div className="space-y-3">
            {toolEvents.map((event, index) => (
              <ToolCallEventLog
                event={event}
                key={event.id || `${event.type}-${index}`}
              />
            ))}
          </div>
        </PagePanel>
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
        <PagePanel variant="section" className="px-5 py-4">
          <div className="mb-3 text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            {t("trajectorydetailview.ProviderAccesses", {
              defaultValue: "Provider Accesses",
            })}
          </div>
          <div className="space-y-4">
            {providerAccesses.map((access, index) => (
              <PagePanel variant="inset" key={access.id} className="p-4">
                <div className="flex flex-col gap-1">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
                    {t("trajectorydetailview.ProviderAccess", {
                      defaultValue: "Provider Access",
                    })}{" "}
                    #{index + 1}
                  </div>
                  <div className="text-sm font-semibold text-txt">
                    {access.providerName || "unknown"}
                  </div>
                  <div className="text-xs-tight text-muted">
                    {access.purpose || "—"}
                  </div>
                </div>
                {access.query ? (
                  <div className="mt-4">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("trajectorydetailview.Query", {
                        defaultValue: "Query",
                      })}
                    </div>
                    <pre className="mt-2 max-h-[18rem] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words rounded-2xl border border-border/50 bg-bg/60 px-4 py-4 text-xs leading-6 text-txt">
                      {formatProviderPayload(access.query)}
                    </pre>
                  </div>
                ) : null}
                <div className="mt-4">
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("trajectorydetailview.Data", {
                      defaultValue: "Data",
                    })}
                  </div>
                  <pre className="mt-2 max-h-[18rem] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words rounded-2xl border border-border/50 bg-bg/60 px-4 py-4 text-xs leading-6 text-txt">
                    {formatProviderPayload(access.data)}
                  </pre>
                </div>
              </PagePanel>
            ))}
          </div>
        </PagePanel>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="space-y-4 pb-1">
          {llmCalls.length === 0 ? (
            <PagePanel.Empty
              variant="surface"
              className="min-h-[18rem]"
              title={t("trajectorydetailview.NoCapturedCalls")}
              description={t("trajectorydetailview.NoLLMCallsRecorde")}
            />
          ) : (
            filteredCalls.map((call) => (
              <TrajectoryLlmCallCard
                key={call.id}
                callLabel={`#${(callIndexMap.get(call.id) ?? 0) + 1}`}
                model={call.model}
                purposeLabel={formatTrajectoryStepLabel(
                  call.stepType || call.purpose || call.actionType,
                  t("trajectorydetailview.Response"),
                )}
                latencyLabel={formatTrajectoryDuration(call.latencyMs)}
                tokensLabel={t("common.tokens")}
                totalTokensValue={formatTrajectoryTokenCount(
                  (call.promptTokens ?? 0) + (call.completionTokens ?? 0),
                  { emptyLabel: "—" },
                )}
                tokenBreakdownMeta={`${formatTrajectoryTokenCount(
                  call.promptTokens ?? 0,
                  { emptyLabel: "—" },
                )}↑ • ${formatTrajectoryTokenCount(call.completionTokens ?? 0, {
                  emptyLabel: "—",
                })} ↓`}
                costLabel={t("trajectorydetailview.Cost")}
                costValue={estimateCost(
                  call.promptTokens ?? 0,
                  call.completionTokens ?? 0,
                  call.model,
                )}
                temperatureLabel={t("trajectorydetailview.Temp")}
                temperatureValue={call.temperature}
                maxLabel={t("trajectorydetailview.Max")}
                maxValue={call.maxTokens > 0 ? call.maxTokens : "—"}
                systemPrompt={call.systemPrompt}
                systemPromptButtonLabel={t("trajectorydetailview.SystemPrompt")}
                systemLabel={t("trajectorydetailview.System")}
                systemLinesLabel={`${call.systemPrompt?.split("\n").length ?? 0} ${t(
                  "trajectorydetailview.lines",
                )}`}
                systemCollapseLabel={t("common.collapse", {
                  defaultValue: "Collapse",
                })}
                systemExpandLabel={t("common.expand", {
                  defaultValue: "Expand",
                })}
                inputLabel={t("trajectorydetailview.InputUser")}
                outputLabel={t("trajectorydetailview.OutputResponse")}
                inputLinesLabel={`${call.userPrompt.split("\n").length} ${t(
                  "trajectorydetailview.lines",
                )}`}
                outputLinesLabel={`${call.response.split("\n").length} ${t(
                  "trajectorydetailview.lines",
                )}`}
                tags={(call.tags ?? []).filter((tag) => tag !== "llm")}
                userPrompt={call.userPrompt}
                response={call.response}
                copyLabel={t("trajectorydetailview.Copy")}
                copyToClipboardLabel={t("trajectorydetailview.CopyToClipboard")}
                onCopy={(content) => {
                  void copyToClipboard(content);
                }}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
