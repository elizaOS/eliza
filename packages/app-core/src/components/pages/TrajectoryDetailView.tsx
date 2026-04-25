import {
  PagePanel,
  type PipelineNode,
  type PipelineStageId,
  TrajectoryLlmCallCard,
  TrajectoryPipelineGraph,
} from "@elizaos/ui";
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
  TrajectoryDetailResult,
  TrajectoryLlmCall,
} from "../../api/client-types-cloud";
import { useApp } from "../../state/useApp";
import {
  formatTrajectoryDuration,
  formatTrajectoryTokenCount,
} from "../../utils/trajectory-format";
import { estimateTokenCost } from "../conversations/conversation-utils";

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
