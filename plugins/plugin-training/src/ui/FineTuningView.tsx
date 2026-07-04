/**
 * FineTuningView — the fine-tuning dashboard's rich GUI/XR React component: the
 * status, trajectories, datasets, backends, jobs, models, benchmark, and
 * analysis-coverage panels wired to the `/api/training/*` endpoints through the
 * shared UI client. Pure formatting/parsing helpers live in
 * `FineTuningView.helpers.ts` and the `interact` capability handler in
 * `FineTuningView.interact.ts`, so this file exports only React components and
 * stays Fast-Refresh-compatible.
 */
import { useAgentElement } from "@elizaos/ui/agent-surface";
import type {
  HuggingFaceDatasetIngestResponse,
  ListTrainingCollectionsResponse,
  RunActionBenchmarkResponse,
  RunBenchmarkVsCerebrasResponse,
  RunFeedGenerationResponse,
  RunLocalEvalComparisonResponse,
  RunScenarioResponse,
  RunTrainingCollectionResponse,
  StageEliza1BundleResponse,
  StartTrainingOptions,
  StreamEventEnvelope,
  TrainingAnalysisIndexResponse,
  TrainingCollectionPreflightSummary,
  TrainingDatasetRecord,
  TrainingJobRecord,
  TrainingModelRecord,
  TrainingReadinessReportResponse,
  TrainingStatus,
  TrainingStreamEvent,
  TrainingTrajectoryDetail,
  TrainingTrajectoryList,
} from "@elizaos/ui/api";
import { client } from "@elizaos/ui/api";
import {
  type AppDetailExtensionProps,
  Button,
  Input,
  registerDetailExtension,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@elizaos/ui/components";
import { useIntervalWhenDocumentVisible } from "@elizaos/ui/hooks";
import { ContentLayout } from "@elizaos/ui/layouts";
import { Escape } from "@elizaos/ui/spatial";
import { type AppContextValue, useAppSelector } from "@elizaos/ui/state";
import {
  confirmDesktopAction,
  openExternalUrl,
  parsePositiveFloat,
  parsePositiveInteger,
} from "@elizaos/ui/utils";
import {
  Children,
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ELIZA_ONE_BENCHMARK_TIER_LIST,
  ELIZA_ONE_BENCHMARK_TIERS,
} from "../core/eliza1-benchmark-recipe.js";
import { toLocalFileUrl } from "../util/local-file-url.js";
import {
  type FineTuningSnapshot,
  FineTuningSpatialView,
} from "./FineTuningSpatialView";
import { asArray, parseCollectionTierList } from "./FineTuningView.helpers";
import { interact } from "./FineTuningView.interact";
import {
  asTrainingEvent,
  FINE_TUNING_ACTION_CLASS,
  FINE_TUNING_SECTION_HEADER_CLASS,
} from "./fine-tuning-panels.helpers";
import {
  DatasetSection,
  LiveEventsPanel,
  TrainedModelsSection,
  TrainingJobsSection,
  TrajectoriesSection,
} from "./fine-tuning-panels.js";

const FINE_TUNING_DETAIL_PANEL_ID = "plugin-dash-fine-tuning";

/* Flat — no card/border. The shell owns the page's horizontal padding;
 * sections separate by whitespace + type scale, panels and status tiles
 * by grid gaps. */
const FINE_TUNING_SECTION_CLASS = "";
const FINE_TUNING_PANEL_CLASS = "";
const FINE_TUNING_STATUS_CARD_CLASS = "";

const DEFAULT_ELIZA1_HF_DATASET_FILES = ELIZA_ONE_BENCHMARK_TIERS.flatMap(
  (tier) =>
    [
      "train.jsonl",
      "val.jsonl",
      "test.jsonl",
      "manifest.json",
      "validation.json",
    ].map((file) => `sft/${tier}/${file}`),
);

function localViewerUrl(path: string): string {
  // `file://${path}` breaks on Windows drive paths (C:\… → file://C:%5C…, where
  // the browser reads `C:` as the host). toLocalFileUrl handles both platforms.
  return toLocalFileUrl(path);
}

interface AnalysisCoverageSummary {
  dataSources: {
    huggingFace: number;
    feed: number;
    natural: number;
    scenarios: number;
    tests: number;
    trainingJsonl: number;
  };
  readableSamples: {
    huggingFace: number;
    feed: number;
    natural: number;
    scenarios: number;
    tests: number;
    trainingJsonl: number;
    total: number;
  };
  evals: number;
  benchmarkMatrices: number;
  models: number;
  benchmarkModelStats: {
    modelCount: number;
    bestModelId: string | null;
    bestAverageScore: number | null;
  };
  allEliza1TiersCovered: boolean;
  benchmarkTierCoverage: Array<{
    tier: string;
    hasBase: boolean;
    hasTrained: boolean;
    hasReference: boolean;
    hasImprovement: boolean;
  }>;
  benchmarkComparisons: Array<{
    tier: string | null;
    benchmark: string | null;
    baseScore: number | null;
    trainedScore: number | null;
    referenceScore: number | null;
    improvementPercent: number | null;
    trainedVsReferencePercent: number | null;
  }>;
}

type TrainingReadinessRecommendedAction = NonNullable<
  TrainingReadinessReportResponse["report"]["checks"][number]["recommendedAction"]
>;

type TrainingReadinessCheckSummary =
  TrainingReadinessReportResponse["report"]["checks"][number];

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringSummaryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberSummaryValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function formatModelInventorySummary(
  modelInventory:
    | NonNullable<
        RunTrainingCollectionResponse["manifest"]["evidence"]["training"]["modelInventory"]
      >
    | undefined,
): string {
  if (!modelInventory?.length) return "";
  const tiers = [
    ...new Set(
      modelInventory
        .map((model) => model.tier)
        .filter((tier): tier is string => Boolean(tier)),
    ),
  ];
  const base = modelInventory.filter(
    (model) => model.variant === "base",
  ).length;
  const trained = modelInventory.filter(
    (model) => model.variant === "trained",
  ).length;
  const parts: string[] = [];
  if (base || trained) parts.push(`base:${base} trained:${trained}`);
  if (tiers.length) parts.push(`tiers:${tiers.join(",")}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatNullableMetric(value: unknown, suffix = ""): string {
  const numberValue = nullableNumberValue(value);
  return numberValue === null ? "n/a" : `${numberValue}${suffix}`;
}

function compactDisplayValue(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? ""
        : JSON.stringify(value);
  return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
}

function formatEvalComparisonSummary(
  result: RunLocalEvalComparisonResponse,
): string | null {
  const artifact = recordValue(result.artifact);
  if (!Object.keys(artifact).length) return null;
  const models = recordValue(artifact.models);
  const metrics = recordValue(artifact.metrics);
  const base = nullableStringValue(models.base) ?? "base";
  const trained = nullableStringValue(models.trained) ?? "trained";
  const backend = nullableStringValue(models.backend) ?? "n/a";
  return `${base} -> ${trained} backend:${backend} base:${formatNullableMetric(
    metrics.baseScore,
  )} trained:${formatNullableMetric(
    metrics.trainedScore,
  )} improvement:${formatNullableMetric(
    metrics.improvementPercent,
    "%",
  )} delta:${formatNullableMetric(
    metrics.improvementAbsolute,
  )} prompts:${formatNullableMetric(metrics.promptCount)} latency:${formatNullableMetric(
    metrics.baseLatencyMs,
    "ms",
  )}->${formatNullableMetric(metrics.trainedLatencyMs, "ms")}`;
}

function summarizeAnalysisCoverage(
  analysisIndex: TrainingAnalysisIndexResponse | null,
): AnalysisCoverageSummary | null {
  if (!analysisIndex) return null;
  const artifacts = asArray(analysisIndex.manifest.artifacts);
  const manifestCoverage = recordValue(
    (analysisIndex.manifest as unknown as Record<string, unknown>).coverage,
  );
  if (Object.keys(manifestCoverage).length > 0) {
    const dataSources = recordValue(manifestCoverage.dataSources);
    const readableSamples = recordValue(manifestCoverage.readableSamples);
    const evals = recordValue(manifestCoverage.evals);
    const benchmarks = recordValue(manifestCoverage.benchmarks);
    const models = recordValue(manifestCoverage.models);
    const inventory = Array.isArray(models.inventory)
      ? models.inventory.map(recordValue)
      : [];
    const benchmarkTierCoverage = Array.isArray(benchmarks.tierCoverage)
      ? benchmarks.tierCoverage.map(recordValue).map((tier) => ({
          tier: nullableStringValue(tier.tier) ?? "unknown",
          hasBase: tier.hasBase === true,
          hasTrained: tier.hasTrained === true,
          hasReference: tier.hasReference === true,
          hasImprovement: tier.hasImprovement === true,
        }))
      : [];
    const benchmarkComparisons = artifacts
      .filter((artifact) => artifact.kind === "benchmark_matrix")
      .flatMap((artifact) => {
        const payload = recordValue(artifact.payload);
        return Array.isArray(payload.comparisons)
          ? payload.comparisons.map(recordValue)
          : [];
      })
      .map((comparison) => ({
        tier: nullableStringValue(comparison.tier),
        benchmark: nullableStringValue(comparison.benchmark),
        baseScore: nullableNumberValue(comparison.baseScore),
        trainedScore: nullableNumberValue(comparison.trainedScore),
        referenceScore: nullableNumberValue(comparison.referenceScore),
        improvementPercent: nullableNumberValue(comparison.improvementPercent),
        trainedVsReferencePercent: nullableNumberValue(
          comparison.trainedVsReferencePercent,
        ),
      }));
    return {
      dataSources: {
        huggingFace: numberSummaryValue(dataSources.huggingFace) ?? 0,
        feed: numberSummaryValue(dataSources.feed) ?? 0,
        natural: numberSummaryValue(dataSources.natural) ?? 0,
        scenarios: numberSummaryValue(dataSources.scenarios) ?? 0,
        tests: numberSummaryValue(dataSources.tests) ?? 0,
        trainingJsonl: numberSummaryValue(dataSources.trainingJsonl) ?? 0,
      },
      readableSamples: {
        huggingFace: numberSummaryValue(readableSamples.huggingFace) ?? 0,
        feed: numberSummaryValue(readableSamples.feed) ?? 0,
        natural: numberSummaryValue(readableSamples.natural) ?? 0,
        scenarios: numberSummaryValue(readableSamples.scenarios) ?? 0,
        tests: numberSummaryValue(readableSamples.tests) ?? 0,
        trainingJsonl: numberSummaryValue(readableSamples.trainingJsonl) ?? 0,
        total: numberSummaryValue(readableSamples.total) ?? 0,
      },
      evals: numberSummaryValue(evals.artifacts) ?? 0,
      benchmarkMatrices: numberSummaryValue(benchmarks.matrices) ?? 0,
      models: numberSummaryValue(models.artifacts) ?? 0,
      benchmarkModelStats: {
        modelCount: inventory.length,
        bestModelId: null,
        bestAverageScore: null,
      },
      allEliza1TiersCovered: benchmarks.allEliza1TiersCovered === true,
      benchmarkTierCoverage,
      benchmarkComparisons,
    };
  }
  const summaryFor = (artifact: (typeof artifacts)[number]) =>
    recordValue(artifact.summary);
  const schemaOf = (artifact: (typeof artifacts)[number]) =>
    stringSummaryValue(summaryFor(artifact).schema);
  const sourceKindOf = (artifact: (typeof artifacts)[number]) =>
    stringSummaryValue(recordValue(summaryFor(artifact).source).kind);
  const sourceLabelOf = (artifact: (typeof artifacts)[number]) => {
    const source = summaryFor(artifact).source;
    return (
      stringSummaryValue(source) ?? stringSummaryValue(recordValue(source).kind)
    );
  };
  const isNaturalTrajectoryBundle = (artifact: (typeof artifacts)[number]) =>
    artifact.kind === "trajectory_bundle" &&
    sourceLabelOf(artifact) === "training_collection_natural_trajectories";
  const isTestTrajectoryDataset = (artifact: (typeof artifacts)[number]) =>
    artifact.kind === "trajectory_dataset" &&
    sourceKindOf(artifact) === "app_core_test_trajectory";
  const sampleCount = (
    artifact: (typeof artifacts)[number],
    keys: readonly string[],
  ) =>
    keys.reduce((count, key) => {
      const samples = summaryFor(artifact)[key];
      return count + (Array.isArray(samples) ? samples.length : 0);
    }, 0);
  const sampleCountFor = (
    predicate: (artifact: (typeof artifacts)[number]) => boolean,
    keys: readonly string[],
  ) =>
    artifacts
      .filter(predicate)
      .reduce((count, artifact) => count + sampleCount(artifact, keys), 0);
  const modelStats = artifacts.flatMap((artifact) => {
    const summary = summaryFor(artifact);
    return Array.isArray(summary.modelStats)
      ? summary.modelStats.map(recordValue)
      : [];
  });
  const scoredModels = modelStats
    .map((stat) => ({
      modelId: stringSummaryValue(stat.modelId),
      averageScore: numberSummaryValue(stat.averageScore),
    }))
    .filter(
      (stat): stat is { modelId: string; averageScore: number } =>
        stat.modelId !== undefined && stat.averageScore !== undefined,
    );
  const bestModel = scoredModels.sort(
    (left, right) => right.averageScore - left.averageScore,
  )[0];
  const benchmarkComparisons = artifacts
    .filter((artifact) => artifact.kind === "benchmark_matrix")
    .flatMap((artifact) => {
      const payload = recordValue(artifact.payload);
      return Array.isArray(payload.comparisons)
        ? payload.comparisons.map(recordValue)
        : [];
    })
    .map((comparison) => ({
      tier: nullableStringValue(comparison.tier),
      benchmark: nullableStringValue(comparison.benchmark),
      baseScore: nullableNumberValue(comparison.baseScore),
      trainedScore: nullableNumberValue(comparison.trainedScore),
      referenceScore: nullableNumberValue(comparison.referenceScore),
      improvementPercent: nullableNumberValue(comparison.improvementPercent),
      trainedVsReferencePercent: nullableNumberValue(
        comparison.trainedVsReferencePercent,
      ),
    }));

  const dataSources = {
    huggingFace: artifacts.filter(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        (schemaOf(artifact) === "eliza_huggingface_dataset_ingest" ||
          sourceKindOf(artifact) === "huggingface_dataset"),
    ).length,
    feed: artifacts.filter(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        (schemaOf(artifact) === "feed_training_trajectory_export" ||
          schemaOf(artifact) === "feed_parallel_generation"),
    ).length,
    natural: artifacts.filter(isNaturalTrajectoryBundle).length,
    scenarios: artifacts.filter(
      (artifact) =>
        artifact.kind === "scenario_run" ||
        schemaOf(artifact) === "eliza_scenario_native_export",
    ).length,
    tests: artifacts.filter(isTestTrajectoryDataset).length,
    trainingJsonl: artifacts.filter(
      (artifact) => schemaOf(artifact) === "eliza_training_jsonl_dataset",
    ).length,
  };
  const readableSamples = {
    huggingFace: sampleCountFor(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        schemaOf(artifact) === "eliza_huggingface_dataset_ingest",
      ["hfSamplePreviews"],
    ),
    feed: sampleCountFor(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        (schemaOf(artifact) === "feed_training_trajectory_export" ||
          schemaOf(artifact) === "feed_parallel_generation"),
      ["feedSamplePreviews"],
    ),
    natural: sampleCountFor(isNaturalTrajectoryBundle, ["samplePreviews"]),
    scenarios: sampleCountFor(
      (artifact) =>
        artifact.kind === "scenario_run" ||
        schemaOf(artifact) === "eliza_scenario_native_export",
      ["turnPreviews", "scenarioNativeSamplePreviews"],
    ),
    tests: sampleCountFor(isTestTrajectoryDataset, ["testSamplePreviews"]),
    trainingJsonl: sampleCountFor(
      (artifact) => schemaOf(artifact) === "eliza_training_jsonl_dataset",
      ["samplePreviews"],
    ),
    total: 0,
  };
  readableSamples.total =
    readableSamples.huggingFace +
    readableSamples.feed +
    readableSamples.natural +
    readableSamples.scenarios +
    readableSamples.tests +
    readableSamples.trainingJsonl;

  return {
    dataSources,
    readableSamples,
    evals: artifacts.filter((artifact) => artifact.kind === "eval").length,
    benchmarkMatrices: artifacts.filter(
      (artifact) => artifact.kind === "benchmark_matrix",
    ).length,
    models: artifacts.filter((artifact) => artifact.kind === "model").length,
    benchmarkModelStats: {
      modelCount: modelStats.length,
      bestModelId: bestModel?.modelId ?? null,
      bestAverageScore: bestModel?.averageScore ?? null,
    },
    allEliza1TiersCovered: false,
    benchmarkTierCoverage: [],
    benchmarkComparisons,
  };
}

/* Bottom-line input — the house resting style for form fields. */
const AGENT_FIELD_INPUT_CLASS =
  "h-11 w-full border-b border-border/60 bg-transparent px-3 text-sm text-txt outline-none focus:border-accent";

function AgentInlineButton({
  agentId,
  label,
  group,
  description,
  className,
  variant = "outline",
  size = "sm",
  disabled,
  onClick,
  title,
  children,
}: {
  agentId: string;
  label: string;
  group: string;
  description: string;
  className: string;
  variant?: "outline" | "ghost" | "link" | "default";
  size?: "sm";
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group,
    description,
    onActivate: onClick,
  });
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      className={className}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={title}
      {...agentProps}
    >
      {children}
    </Button>
  );
}

function AgentTextField({
  agentId,
  label,
  group,
  description,
  className,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  agentId: string;
  label: string;
  group: string;
  description: string;
  className: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "number";
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: agentId,
    role: type === "number" ? "number-input" : "text-input",
    label,
    group,
    description,
    getValue: () => value,
    onFill: onChange,
  });
  return (
    <Input
      ref={ref}
      type={type}
      className={className}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
      {...agentProps}
    />
  );
}

function AgentTextAreaField({
  agentId,
  label,
  group,
  description,
  className,
  value,
  onChange,
  placeholder,
}: {
  agentId: string;
  label: string;
  group: string;
  description: string;
  className: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLTextAreaElement>({
    id: agentId,
    role: "textarea",
    label,
    group,
    description,
    getValue: () => value,
    onFill: onChange,
  });
  return (
    <Textarea
      ref={ref}
      className={className}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
      {...agentProps}
    />
  );
}

function AgentNativeSelect({
  agentId,
  label,
  group,
  description,
  className,
  value,
  onChange,
  options,
  children,
}: {
  agentId: string;
  label: string;
  group: string;
  description: string;
  className: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  children: ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "select",
    label,
    group,
    description,
    options,
    getValue: () => value,
    onFill: onChange,
  });
  const selectItems = Children.toArray(children)
    .map((child) => {
      if (!isValidElement<{ value?: unknown; children?: ReactNode }>(child)) {
        return null;
      }
      const optionValue = child.props.value;
      if (typeof optionValue !== "string") {
        return null;
      }
      return { value: optionValue, label: child.props.children };
    })
    .filter((item): item is { value: string; label: ReactNode } => !!item);

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        ref={ref}
        className={className}
        aria-label={label}
        {...agentProps}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {selectItems.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AgentCheckboxField({
  agentId,
  label,
  group,
  description,
  checked,
  onChange,
}: {
  agentId: string;
  label: string;
  group: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: agentId,
    role: "toggle",
    label,
    group,
    description,
    status: checked ? "active" : "inactive",
    getValue: () => checked,
    onActivate: () => onChange(!checked),
    onFill: (value) => onChange(value === "true" || value === "1"),
  });
  return (
    <Input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      aria-label={label}
      aria-current={checked ? "true" : undefined}
      className="h-4 w-4 p-0"
      {...agentProps}
    />
  );
}

function ReadinessCheckRow({
  check,
  readinessActionRunning,
  onRunRecommendation,
  t,
}: {
  check: TrainingReadinessCheckSummary;
  readinessActionRunning: string | null;
  onRunRecommendation: (
    checkId: string,
    action: TrainingReadinessRecommendedAction,
  ) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `readiness-run-${check.id}`,
    role: "button",
    label: `Run recommendation for ${check.label}`,
    group: "readiness",
    description: `Run the recommended action for the ${check.label} check`,
    onActivate: () => {
      if (check.recommendedAction) {
        onRunRecommendation(check.id, check.recommendedAction);
      }
    },
  });
  return (
    <div className="grid gap-2 pt-2">
      <div>
        <div className="font-mono text-xs text-txt">
          {check.label} · {check.status}
        </div>
        <div className="mt-1 text-xs text-muted">{check.note}</div>
      </div>
      {check.recommendedAction ? (
        <div className="flex flex-col items-start gap-2">
          <div className="break-all font-mono text-xs text-muted">
            {check.recommendedAction.capability}
            {Object.keys(check.recommendedAction.params).length > 0
              ? ` ${JSON.stringify(check.recommendedAction.params)}`
              : ""}
          </div>
          <Button
            ref={ref}
            variant="outline"
            size="sm"
            className={FINE_TUNING_ACTION_CLASS}
            disabled={readinessActionRunning !== null}
            onClick={() => {
              if (check.recommendedAction) {
                onRunRecommendation(check.id, check.recommendedAction);
              }
            }}
            {...agentProps}
          >
            {readinessActionRunning === check.id
              ? t("finetuningview.RunningRecommendation", {
                  defaultValue: "Running",
                })
              : t("finetuningview.RunRecommendation", {
                  defaultValue: "Run recommendation",
                })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function TrainingActionButton({
  agentId,
  label,
  group,
  description,
  disabled,
  onClick,
  children,
}: {
  agentId: string;
  label: string;
  group: string;
  description: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group,
    description,
  });
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      className={FINE_TUNING_ACTION_CLASS}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      {...agentProps}
    >
      {children}
    </Button>
  );
}

const EMPTY_FINE_TUNING_SNAPSHOT: FineTuningSnapshot = {
  runtimeAvailable: false,
  runningJobs: 0,
  queuedJobs: 0,
  completedJobs: 0,
  failedJobs: 0,
  jobs: [],
  models: 0,
  datasets: 0,
  trajectoryCount: 0,
};

/**
 * FineTuningView — the single GUI / XR / TUI componentExport.
 *
 * GUI and XR render the full rich {@link FineTuningDashboard} (its real DOM:
 * forms, panels, the live-event stream) through the spatial `Escape` hatch; TUI
 * falls back to the presentational {@link FineTuningSpatialView} summary. That
 * same `FineTuningSpatialView` is the source the agent terminal renders directly
 * via `registerFineTuningTerminalView` (see `register-terminal-view.tsx`), so
 * there is exactly one registered component and one terminal source.
 */
export function FineTuningView(props: { contentHeader?: ReactNode } = {}) {
  return (
    <Escape
      tui={<FineTuningSpatialView snapshot={EMPTY_FINE_TUNING_SNAPSHOT} />}
    >
      <FineTuningDashboard {...props} />
    </Escape>
  );
}

export function FineTuningDashboard({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  const handleRestart = useAppSelector((s: AppContextValue) => s.handleRestart);
  const setActionNotice = useAppSelector(
    (s: AppContextValue) => s.setActionNotice,
  );
  const t = useAppSelector((s: AppContextValue) => s.t);

  const [pageLoading, setPageLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [status, setStatus] = useState<TrainingStatus | null>(null);
  const [trajectoryList, setTrajectoryList] = useState<TrainingTrajectoryList>({
    available: false,
    total: 0,
    trajectories: [],
  });
  const [selectedTrajectory, setSelectedTrajectory] =
    useState<TrainingTrajectoryDetail | null>(null);
  const [trajectoryLoading, setTrajectoryLoading] = useState(false);
  const [publishingTrajectories, setPublishingTrajectories] = useState(false);
  const [publishConfigured, setPublishConfigured] = useState(true);

  const [datasets, setDatasets] = useState<TrainingDatasetRecord[]>([]);
  const [jobs, setJobs] = useState<TrainingJobRecord[]>([]);
  const [models, setModels] = useState<TrainingModelRecord[]>([]);
  const [analysisIndex, setAnalysisIndex] =
    useState<TrainingAnalysisIndexResponse | null>(null);
  const analysisCoverage = useMemo(
    () => summarizeAnalysisCoverage(analysisIndex),
    [analysisIndex],
  );
  const [analysisBuilding, setAnalysisBuilding] = useState(false);
  const [readinessBuilding, setReadinessBuilding] = useState(false);
  const [readinessReport, setReadinessReport] =
    useState<TrainingReadinessReportResponse | null>(null);
  const [readinessActionRunning, setReadinessActionRunning] = useState<
    string | null
  >(null);
  const [collectionRunning, setCollectionRunning] = useState(false);
  const [collectionPreflightRunning, setCollectionPreflightRunning] =
    useState(false);
  const [collectionResult, setCollectionResult] =
    useState<RunTrainingCollectionResponse | null>(null);
  const [collectionPreflightResult, setCollectionPreflightResult] =
    useState<TrainingCollectionPreflightSummary | null>(null);
  const [collectionPreflightProbe, setCollectionPreflightProbe] =
    useState(true);
  const [collectionHistory, setCollectionHistory] =
    useState<ListTrainingCollectionsResponse | null>(null);
  const [collectionHistoryLoading, setCollectionHistoryLoading] =
    useState(false);
  const [hfIngestRunning, setHfIngestRunning] = useState(false);
  const [hfIngestResult, setHfIngestResult] =
    useState<HuggingFaceDatasetIngestResponse | null>(null);
  const [hfRepoId, setHfRepoId] = useState("elizaos/eliza-1-training");
  const [hfRevision, setHfRevision] = useState("main");
  const [hfFiles, setHfFiles] = useState(
    DEFAULT_ELIZA1_HF_DATASET_FILES.join("\n"),
  );
  const [hfOutputDir, setHfOutputDir] = useState("");
  const [hfDryRun, setHfDryRun] = useState(true);
  const [feedGenerationRunning, setFeedGenerationRunning] = useState(false);
  const [feedGenerationResult, setFeedGenerationResult] =
    useState<RunFeedGenerationResponse | null>(null);
  const [feedArchetypes, setFeedArchetypes] = useState("trader");
  const [feedNumAgents, setFeedNumAgents] = useState("1");
  const [feedTicks, setFeedTicks] = useState("1");
  const [feedParallel, setFeedParallel] = useState("1");
  const [feedOutputDir, setFeedOutputDir] = useState("");
  const [feedCleanup, setFeedCleanup] = useState(true);
  const [feedDryRun, setFeedDryRun] = useState(true);
  const [naturalSanitizedJsonlPath, setNaturalSanitizedJsonlPath] =
    useState("");
  const [naturalRawJsonlPath, setNaturalRawJsonlPath] = useState("");
  const [naturalRunId, setNaturalRunId] = useState("");
  const [naturalTasks, setNaturalTasks] = useState("response,action_planner");
  const [naturalIncludeRaw, setNaturalIncludeRaw] = useState(false);
  const [scenarioFilter, setScenarioFilter] = useState(
    "deterministic-pr-smoke",
  );
  const [scenarioOutputDir, setScenarioOutputDir] = useState("");
  const [scenarioDryRun, setScenarioDryRun] = useState(true);
  const [scenarioExportNative, setScenarioExportNative] = useState(true);
  const [scenarioDeterministicProxy, setScenarioDeterministicProxy] =
    useState(true);
  const [scenarioRunning, setScenarioRunning] = useState(false);
  const [scenarioResult, setScenarioResult] =
    useState<RunScenarioResponse | null>(null);
  const [evalComparisonRunning, setEvalComparisonRunning] = useState(false);
  const [evalComparisonResult, setEvalComparisonResult] =
    useState<RunLocalEvalComparisonResponse | null>(null);
  const [evalComparisonEnabled, setEvalComparisonEnabled] = useState(true);
  const [evalComparisonManifestPath, setEvalComparisonManifestPath] =
    useState("");
  const [evalComparisonBaseModel, setEvalComparisonBaseModel] =
    useState("eliza-1-2b-base");
  const [evalComparisonTrainedModelPath, setEvalComparisonTrainedModelPath] =
    useState("eliza-1-2b-trained");
  const [evalComparisonBackend, setEvalComparisonBackend] = useState<
    "cpu" | "mlx" | "cuda"
  >("cpu");
  const [evalComparisonOutputDir, setEvalComparisonOutputDir] = useState("");
  const [evalComparisonDryRun, setEvalComparisonDryRun] = useState(true);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkResult, setBenchmarkResult] =
    useState<RunBenchmarkVsCerebrasResponse | null>(null);
  const [benchmarkTiers, setBenchmarkTiers] = useState("2b");
  const [benchmarkKind, setBenchmarkKind] = useState<
    "eliza_harness_action_selection" | "hermes" | "clawbench" | "all"
  >("eliza_harness_action_selection");
  const [benchmarkVariants, setBenchmarkVariants] = useState<
    "trained" | "base" | "both"
  >("both");
  const [benchmarkMaxSamples, setBenchmarkMaxSamples] = useState("50");
  const [benchmarkResultsDb, setBenchmarkResultsDb] = useState("");
  const [benchmarkTrainedModelPath, setBenchmarkTrainedModelPath] =
    useState("");
  const [benchmarkMatrixOutputDir, setBenchmarkMatrixOutputDir] = useState("");
  const [benchmarkDryRun, setBenchmarkDryRun] = useState(true);
  const [bundleStageRunning, setBundleStageRunning] = useState(false);
  const [bundleStageResult, setBundleStageResult] =
    useState<StageEliza1BundleResponse | null>(null);
  const [bundleStageRepoId, setBundleStageRepoId] = useState("elizaos/eliza-1");
  const [bundleStageTier, setBundleStageTier] = useState("2b");
  const [bundleStageLocalDir, setBundleStageLocalDir] = useState(
    "/tmp/eliza-1-bundles",
  );
  const [bundleStageOutputDir, setBundleStageOutputDir] = useState("");
  const [bundleStageMaxBytes, setBundleStageMaxBytes] = useState("8589934592");
  const [bundleStageApply, setBundleStageApply] = useState(false);
  const [actionBenchmarkRunning, setActionBenchmarkRunning] = useState(false);
  const [actionBenchmarkResult, setActionBenchmarkResult] =
    useState<RunActionBenchmarkResponse | null>(null);
  const [actionBenchmarkFilter, setActionBenchmarkFilter] = useState("");
  const [actionBenchmarkRunsPerCase, setActionBenchmarkRunsPerCase] =
    useState("1");
  const [actionBenchmarkOutputDir, setActionBenchmarkOutputDir] = useState("");
  const [actionBenchmarkModelId, setActionBenchmarkModelId] =
    useState("eliza-1-2b-trained");
  const [actionBenchmarkRuntimeModel, setActionBenchmarkRuntimeModel] =
    useState("eliza-1-2b-trained");
  const [actionBenchmarkPairEnabled, setActionBenchmarkPairEnabled] =
    useState(true);
  const [actionBenchmarkPairTiers, setActionBenchmarkPairTiers] =
    useState("2b");
  const [actionBenchmarkBaseModelId, setActionBenchmarkBaseModelId] =
    useState("eliza-1-2b-base");
  const [actionBenchmarkBaseRuntimeModel, setActionBenchmarkBaseRuntimeModel] =
    useState("eliza-1-2b-base");
  const [actionBenchmarkProvider, setActionBenchmarkProvider] =
    useState("local-llama-cpp");
  const [actionBenchmarkBaseUrl, setActionBenchmarkBaseUrl] = useState(
    "http://localhost:11434/v1",
  );
  const [actionBenchmarkVariant, setActionBenchmarkVariant] = useState<
    "reference" | "base" | "trained"
  >("trained");
  const [actionBenchmarkTier, setActionBenchmarkTier] = useState("2b");
  const [actionBenchmarkMatrixBenchmark, setActionBenchmarkMatrixBenchmark] =
    useState("eliza_harness_action_selection");
  const [actionBenchmarkDatasetVersion, setActionBenchmarkDatasetVersion] =
    useState("eliza-native-v1");
  const [actionBenchmarkUseMocks, setActionBenchmarkUseMocks] = useState(false);
  const [actionBenchmarkCapture, setActionBenchmarkCapture] = useState(true);
  const [actionBenchmarkDryRun, setActionBenchmarkDryRun] = useState(true);

  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [selectedJobId, setSelectedJobId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");

  const [buildLimit, setBuildLimit] = useState("250");
  const [buildMinCalls, setBuildMinCalls] = useState("1");
  const [datasetBuilding, setDatasetBuilding] = useState(false);

  const [startBackend, setStartBackend] = useState<"mlx" | "cuda" | "cpu">(
    "cpu",
  );
  const [startModel, setStartModel] = useState("");
  const [startIterations, setStartIterations] = useState("");
  const [startBatchSize, setStartBatchSize] = useState("");
  const [startLearningRate, setStartLearningRate] = useState("");
  const [startingJob, setStartingJob] = useState(false);
  const [cancellingJobId, setCancellingJobId] = useState("");

  const [importModelName, setImportModelName] = useState("");
  const [importBaseModel, setImportBaseModel] = useState("");
  const [importOllamaUrl, setImportOllamaUrl] = useState(
    "http://localhost:11434",
  );
  const [activateProviderModel, setActivateProviderModel] = useState("");
  const [modelAction, setModelAction] = useState("");
  const [smokeResult, setSmokeResult] = useState<string | null>(null);

  const [trainingEvents, setTrainingEvents] = useState<TrainingStreamEvent[]>(
    [],
  );

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId],
  );
  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? null,
    [models, selectedModelId],
  );
  const activeRunningJob = useMemo(
    () =>
      jobs.find((job) => job.status === "running" || job.status === "queued") ??
      null,
    [jobs],
  );

  const loadStatus = useCallback(async () => {
    const nextStatus = await client.getTrainingStatus();
    setStatus(nextStatus);
  }, []);

  const loadTrajectories = useCallback(async () => {
    const listed = await client.listTrainingTrajectories({
      limit: 100,
      offset: 0,
    });
    setTrajectoryList(listed);
  }, []);

  const loadDatasets = useCallback(async () => {
    const listed = await client.listTrainingDatasets();
    const nextDatasets = asArray<TrainingDatasetRecord>(listed.datasets);
    setDatasets(nextDatasets);
    setSelectedDatasetId((prev) => {
      if (prev && nextDatasets.some((dataset) => dataset.id === prev)) {
        return prev;
      }
      return nextDatasets[0]?.id ?? "";
    });
  }, []);

  const loadJobs = useCallback(async () => {
    const listed = await client.listTrainingJobs();
    const nextJobs = asArray<TrainingJobRecord>(listed.jobs);
    setJobs(nextJobs);
    setSelectedJobId((prev) => {
      if (prev && nextJobs.some((job) => job.id === prev)) return prev;
      return nextJobs[0]?.id ?? "";
    });
  }, []);

  const loadModels = useCallback(async () => {
    const listed = await client.listTrainingModels();
    const nextModels = asArray<TrainingModelRecord>(listed.models);
    setModels(nextModels);
    setSelectedModelId((prev) => {
      if (prev && nextModels.some((model) => model.id === prev)) return prev;
      return nextModels[0]?.id ?? "";
    });
  }, []);

  const loadCollectionHistory = useCallback(async () => {
    setCollectionHistoryLoading(true);
    try {
      const listed = await client.listTrainingCollections({ limit: 10 });
      setCollectionHistory(listed);
    } catch (err) {
      // Collection history is one panel among many. A failure here must not
      // reject the shared refreshAll() Promise.all and blank the whole view —
      // surface it as a non-blocking notice and keep any prior history.
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToLoadCollectionHistory", {
              defaultValue: "Failed to load collection history",
            }),
        "error",
        4200,
      );
    } finally {
      setCollectionHistoryLoading(false);
    }
  }, [setActionNotice, t]);

  const refreshAll = useCallback(async () => {
    setPageLoading(true);
    setErrorMessage(null);
    try {
      await Promise.all([
        loadStatus(),
        loadTrajectories(),
        loadDatasets(),
        loadJobs(),
        loadModels(),
        loadCollectionHistory(),
      ]);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToRefreshState"),
      );
    } finally {
      setPageLoading(false);
    }
  }, [
    loadCollectionHistory,
    loadDatasets,
    loadJobs,
    loadModels,
    loadStatus,
    loadTrajectories,
    t,
  ]);

  const loadTrajectoryDetail = useCallback(
    async (trajectoryId: string) => {
      setTrajectoryLoading(true);
      try {
        const result = await client.getTrainingTrajectory(trajectoryId);
        setSelectedTrajectory(result.trajectory);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : t("finetuningview.FailedToLoadTrajectoryDetail");
        setActionNotice(message, "error", 4200);
      } finally {
        setTrajectoryLoading(false);
      }
    },
    [setActionNotice, t],
  );

  const handlePublishTrajectories = useCallback(async () => {
    setPublishingTrajectories(true);
    try {
      const response = await fetch("/api/training/trajectories/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (response.status === 409) {
        setPublishConfigured(false);
        const detail = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setActionNotice(
          detail?.error ?? t("finetuningview.HuggingFacePublishNotConfigured"),
          "error",
          5200,
        );
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        trajectoriesPublished?: number;
        cloudUpload?: { huggingFaceRepo?: string; huggingFacePath?: string };
      } | null;
      if (!response.ok) {
        setActionNotice(
          payload?.error ?? t("finetuningview.FailedToPublishTrajectories"),
          "error",
          5200,
        );
        return;
      }
      setPublishConfigured(true);
      setActionNotice(
        t("finetuningview.PublishedTrajectoriesMessage", {
          count: payload?.trajectoriesPublished ?? 0,
          repo: payload?.cloudUpload?.huggingFaceRepo ?? "",
        }),
        "success",
        4200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToPublishTrajectories"),
        "error",
        5200,
      );
    } finally {
      setPublishingTrajectories(false);
    }
  }, [setActionNotice, t]);

  const handleBuildDataset = useCallback(async () => {
    setDatasetBuilding(true);
    try {
      const limit = parsePositiveInteger(buildLimit);
      const minLlmCallsPerTrajectory = parsePositiveInteger(buildMinCalls);
      const request: { limit?: number; minLlmCallsPerTrajectory?: number } = {};
      if (typeof limit === "number") request.limit = limit;
      if (typeof minLlmCallsPerTrajectory === "number") {
        request.minLlmCallsPerTrajectory = minLlmCallsPerTrajectory;
      }

      const result = await client.buildTrainingDataset(request);
      setSelectedDatasetId(result.dataset.id);
      await Promise.all([loadDatasets(), loadStatus()]);
      setActionNotice(
        t("finetuningview.BuiltDatasetMessage", {
          id: result.dataset.id,
          count: result.dataset.sampleCount,
        }),
        "success",
        3800,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToBuildDataset"),
        "error",
        4200,
      );
    } finally {
      setDatasetBuilding(false);
    }
  }, [buildLimit, buildMinCalls, loadDatasets, loadStatus, setActionNotice, t]);

  const handleBuildAnalysisIndex = useCallback(async () => {
    setAnalysisBuilding(true);
    try {
      const result = await client.buildTrainingAnalysisIndex();
      setAnalysisIndex(result);
      setActionNotice(
        t("finetuningview.BuiltAnalysisIndexMessage", {
          count: result.manifest.artifacts.length,
        }),
        "success",
        4200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToBuildAnalysisIndex"),
        "error",
        5200,
      );
    } finally {
      setAnalysisBuilding(false);
    }
  }, [setActionNotice, t]);

  const handleBuildReadinessReport = useCallback(async () => {
    setReadinessBuilding(true);
    try {
      const result = await client.buildTrainingReadinessReport();
      setReadinessReport(result);
      setActionNotice(
        t("finetuningview.ReadinessReportCompleted", {
          status: result.report.status,
          missing: result.report.counts.missing ?? 0,
        }),
        result.report.status === "missing" ? "error" : "success",
        5200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToBuildReadinessReport"),
        "error",
        5200,
      );
    } finally {
      setReadinessBuilding(false);
    }
  }, [setActionNotice, t]);

  const handleRunReadinessRecommendation = useCallback(
    async (checkId: string, action: TrainingReadinessRecommendedAction) => {
      setReadinessActionRunning(checkId);
      try {
        const result = await interact(action.capability, action.params);
        if (action.capability === "terminal-training-build-analysis-index") {
          setAnalysisIndex(result as TrainingAnalysisIndexResponse);
        } else if (
          action.capability === "terminal-training-build-readiness-report"
        ) {
          setReadinessReport(result as TrainingReadinessReportResponse);
        } else if (
          action.capability === "terminal-training-ingest-hf-dataset"
        ) {
          setHfIngestResult(result as HuggingFaceDatasetIngestResponse);
        } else if (action.capability === "terminal-training-feed-generate") {
          setFeedGenerationResult(result as RunFeedGenerationResponse);
        } else if (
          action.capability === "terminal-training-run-eval-comparison"
        ) {
          setEvalComparisonResult(result as RunLocalEvalComparisonResponse);
        } else if (action.capability === "terminal-training-run-scenarios") {
          setScenarioResult(result as RunScenarioResponse);
        } else if (
          action.capability === "terminal-training-run-benchmark-vs-cerebras"
        ) {
          setBenchmarkResult(result as RunBenchmarkVsCerebrasResponse);
        } else if (
          action.capability === "terminal-training-stage-eliza1-bundle"
        ) {
          setBundleStageResult(result as StageEliza1BundleResponse);
        } else if (
          action.capability === "terminal-training-run-action-benchmark"
        ) {
          setActionBenchmarkResult(result as RunActionBenchmarkResponse);
        } else if (action.capability === "terminal-training-run-collection") {
          setCollectionResult(result as RunTrainingCollectionResponse);
          await loadCollectionHistory();
        }

        if (action.capability !== "terminal-training-build-readiness-report") {
          const refreshed = await client.buildTrainingReadinessReport();
          setReadinessReport(refreshed);
        }

        setActionNotice(
          t("finetuningview.ReadinessRecommendationCompleted", {
            defaultValue: `Ran ${action.capability}`,
          }),
          "success",
          5200,
        );
      } catch (err) {
        setActionNotice(
          err instanceof Error
            ? err.message
            : t("finetuningview.FailedToRunReadinessRecommendation", {
                defaultValue: "Failed to run readiness recommendation",
              }),
          "error",
          5200,
        );
      } finally {
        setReadinessActionRunning(null);
      }
    },
    [loadCollectionHistory, setActionNotice, t],
  );

  const handleRunTrainingCollection = useCallback(
    async (preflightOnly = false) => {
      if (preflightOnly) {
        setCollectionPreflightRunning(true);
      } else {
        setCollectionRunning(true);
      }
      try {
        const hfFilesList = hfFiles
          .split(/\r?\n|,/)
          .map((file) => file.trim())
          .filter(Boolean);
        const actionBenchmarkTiers = parseCollectionTierList(
          actionBenchmarkPairTiers,
        );
        const actionBenchmarkTierForSinglePair =
          actionBenchmarkTier.trim() || undefined;
        const useDerivedActionBenchmarkPairs =
          actionBenchmarkPairEnabled &&
          actionBenchmarkTiers.length > 0 &&
          (actionBenchmarkTiers.length > 1 ||
            actionBenchmarkTiers[0] !== actionBenchmarkTierForSinglePair);
        const naturalTaskList = naturalTasks
          .split(",")
          .map((task) => task.trim())
          .filter(Boolean);
        const naturalTrajectoryOptions =
          naturalSanitizedJsonlPath.trim() ||
          naturalRawJsonlPath.trim() ||
          naturalRunId.trim() ||
          naturalTaskList.length > 0 ||
          naturalIncludeRaw
            ? {
                sanitizedJsonlPath:
                  naturalSanitizedJsonlPath.trim() || undefined,
                rawJsonlPath: naturalRawJsonlPath.trim() || undefined,
                includeRawJsonl:
                  naturalIncludeRaw || !!naturalRawJsonlPath.trim(),
                tasks: naturalTaskList.length > 0 ? naturalTaskList : undefined,
                source: {
                  kind: "training_collection_natural_trajectories",
                  runId: naturalRunId.trim() || undefined,
                  metadata: {
                    ui: true,
                    sanitizedJsonlPath:
                      naturalSanitizedJsonlPath.trim() || undefined,
                    rawJsonlPath: naturalRawJsonlPath.trim() || undefined,
                  },
                },
              }
            : undefined;
        const result = await client.runTrainingCollection({
          preflightOnly,
          preflightProbe: collectionPreflightProbe,
          includeHuggingFace: true,
          includeFeed: true,
          includeNaturalTrajectories: true,
          includeTestTrajectories: true,
          includeScenarios: true,
          includeEvalComparison: evalComparisonEnabled,
          includeActionBenchmark: true,
          includeBenchmarkVsCerebras: true,
          includeEliza1ModelRegistry: true,
          includeEliza1BundleStage: true,
          includeBenchmarkMatrix: true,
          huggingFace: {
            repoId: hfRepoId.trim() || undefined,
            revision: hfRevision.trim() || undefined,
            files: hfFilesList.length > 0 ? hfFilesList : undefined,
            dryRun: hfDryRun,
            outputDir: hfOutputDir.trim() || undefined,
          },
          feed: {
            archetypes: feedArchetypes.trim() || undefined,
            numAgents: parsePositiveInteger(feedNumAgents),
            ticks: parsePositiveInteger(feedTicks),
            parallel: parsePositiveInteger(feedParallel),
            cleanup: feedCleanup,
            dryRun: feedDryRun,
            outputDir: feedOutputDir.trim() || undefined,
          },
          naturalTrajectories: naturalTrajectoryOptions,
          scenarios: {
            dryRun: scenarioDryRun,
            scenario: scenarioFilter.trim() || undefined,
            outputDir: scenarioOutputDir.trim() || undefined,
            exportNative: scenarioExportNative,
            useDeterministicProxy: scenarioDeterministicProxy,
          },
          evalComparison: {
            manifestPath: evalComparisonManifestPath.trim() || undefined,
            model: evalComparisonManifestPath.trim()
              ? undefined
              : evalComparisonBaseModel.trim() || undefined,
            trainedModelPath: evalComparisonManifestPath.trim()
              ? undefined
              : evalComparisonTrainedModelPath.trim() || undefined,
            backend: evalComparisonManifestPath.trim()
              ? undefined
              : evalComparisonBackend,
            outputDir: evalComparisonOutputDir.trim() || undefined,
            dryRun: evalComparisonDryRun,
          },
          actionBenchmark: {
            filter: actionBenchmarkFilter.trim() || undefined,
            runsPerCase: parsePositiveInteger(actionBenchmarkRunsPerCase),
            outputDir: actionBenchmarkOutputDir.trim() || undefined,
            provider: actionBenchmarkProvider.trim() || undefined,
            modelId: actionBenchmarkModelId.trim() || undefined,
            runtimeModel: actionBenchmarkRuntimeModel.trim() || undefined,
            baseUrl: actionBenchmarkBaseUrl.trim() || undefined,
            variant: actionBenchmarkVariant,
            tier: actionBenchmarkTier.trim() || undefined,
            benchmark: actionBenchmarkMatrixBenchmark.trim() || undefined,
            datasetVersion: actionBenchmarkDatasetVersion.trim() || undefined,
            useMocks: actionBenchmarkUseMocks,
            forceTrajectoryCapture: actionBenchmarkCapture,
            dryRun: actionBenchmarkDryRun,
          },
          actionBenchmarkPair: actionBenchmarkPairEnabled
            ? !useDerivedActionBenchmarkPairs
              ? {
                  tier: actionBenchmarkTierForSinglePair,
                  base: {
                    modelId: actionBenchmarkBaseModelId.trim() || undefined,
                    runtimeModel:
                      actionBenchmarkBaseRuntimeModel.trim() || undefined,
                    variant: "base",
                  },
                  trained: {
                    modelId: actionBenchmarkModelId.trim() || undefined,
                    runtimeModel:
                      actionBenchmarkRuntimeModel.trim() || undefined,
                    variant: "trained",
                  },
                }
              : undefined
            : undefined,
          actionBenchmarkPairs: useDerivedActionBenchmarkPairs
            ? actionBenchmarkTiers.map((tier) => ({
                tier,
                base: { variant: "base" },
                trained: { variant: "trained" },
              }))
            : undefined,
          benchmarkVsCerebras: {
            tiers: benchmarkTiers.trim() || undefined,
            benchmark: benchmarkKind,
            variants: benchmarkVariants,
            maxSamples: parsePositiveInteger(benchmarkMaxSamples),
            dryRun: benchmarkDryRun,
            resultsDb: benchmarkResultsDb.trim() || undefined,
            trainedModelPath: benchmarkTrainedModelPath.trim() || undefined,
            matrixOutputDir: benchmarkMatrixOutputDir.trim() || undefined,
          },
          eliza1BundleStage: {
            repoId: bundleStageRepoId.trim() || undefined,
            tier: bundleStageTier.trim() || undefined,
            localDir: bundleStageLocalDir.trim() || undefined,
            outputDir: bundleStageOutputDir.trim() || undefined,
            maxBytes: parsePositiveInteger(bundleStageMaxBytes),
            apply: bundleStageApply,
          },
        });
        if ("preflight" in result) {
          setCollectionPreflightResult(result.preflight);
          setActionNotice(
            t("finetuningview.CollectionPreflightCompleted", {
              defaultValue: "Collection preflight completed",
            }),
            "success",
            5200,
          );
          return;
        }
        setCollectionResult(result);
        setCollectionPreflightResult(
          result.manifest.evidence.preflight ?? null,
        );
        setAnalysisIndex(result.analysis);
        await loadCollectionHistory();
        setActionNotice(
          t("finetuningview.TrainingCollectionCompleted", {
            count: result.analysis.manifest.artifacts.length,
          }),
          "success",
          5200,
        );
      } catch (err) {
        setActionNotice(
          err instanceof Error
            ? err.message
            : t("finetuningview.FailedToRunTrainingCollection"),
          "error",
          5200,
        );
      } finally {
        if (preflightOnly) {
          setCollectionPreflightRunning(false);
        } else {
          setCollectionRunning(false);
        }
      }
    },
    [
      actionBenchmarkCapture,
      actionBenchmarkDryRun,
      actionBenchmarkFilter,
      actionBenchmarkBaseModelId,
      actionBenchmarkBaseRuntimeModel,
      actionBenchmarkDatasetVersion,
      actionBenchmarkMatrixBenchmark,
      actionBenchmarkModelId,
      actionBenchmarkBaseUrl,
      actionBenchmarkOutputDir,
      actionBenchmarkPairEnabled,
      actionBenchmarkPairTiers,
      actionBenchmarkProvider,
      actionBenchmarkRunsPerCase,
      actionBenchmarkRuntimeModel,
      actionBenchmarkTier,
      actionBenchmarkUseMocks,
      actionBenchmarkVariant,
      benchmarkDryRun,
      benchmarkKind,
      benchmarkMatrixOutputDir,
      benchmarkMaxSamples,
      benchmarkResultsDb,
      benchmarkTiers,
      benchmarkTrainedModelPath,
      benchmarkVariants,
      bundleStageApply,
      bundleStageLocalDir,
      bundleStageMaxBytes,
      bundleStageOutputDir,
      bundleStageRepoId,
      bundleStageTier,
      collectionPreflightProbe,
      evalComparisonBackend,
      evalComparisonBaseModel,
      evalComparisonDryRun,
      evalComparisonEnabled,
      evalComparisonManifestPath,
      evalComparisonOutputDir,
      evalComparisonTrainedModelPath,
      feedArchetypes,
      feedCleanup,
      feedDryRun,
      feedNumAgents,
      feedOutputDir,
      feedParallel,
      feedTicks,
      hfDryRun,
      hfFiles,
      hfOutputDir,
      hfRepoId,
      hfRevision,
      loadCollectionHistory,
      naturalIncludeRaw,
      naturalRawJsonlPath,
      naturalRunId,
      naturalSanitizedJsonlPath,
      naturalTasks,
      scenarioDeterministicProxy,
      scenarioDryRun,
      scenarioExportNative,
      scenarioFilter,
      scenarioOutputDir,
      setActionNotice,
      t,
    ],
  );

  const handleRunEvalComparison = useCallback(async () => {
    setEvalComparisonRunning(true);
    try {
      const result = await client.runTrainingLocalEvalComparison({
        manifestPath: evalComparisonManifestPath.trim() || undefined,
        model: evalComparisonManifestPath.trim()
          ? undefined
          : evalComparisonBaseModel.trim() || undefined,
        trainedModelPath: evalComparisonManifestPath.trim()
          ? undefined
          : evalComparisonTrainedModelPath.trim() || undefined,
        backend: evalComparisonManifestPath.trim()
          ? undefined
          : evalComparisonBackend,
        outputDir: evalComparisonOutputDir.trim() || undefined,
        dryRun: evalComparisonDryRun,
      });
      setEvalComparisonResult(result);
      setActionNotice(
        result.exitCode === 0
          ? t("finetuningview.EvalComparisonCompleted")
          : t("finetuningview.EvalComparisonFailed", {
              exitCode: result.exitCode,
            }),
        result.exitCode === 0 ? "success" : "error",
        5200,
      );
      if (!evalComparisonDryRun) {
        void handleBuildAnalysisIndex();
      }
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToRunEvalComparison"),
        "error",
        5200,
      );
    } finally {
      setEvalComparisonRunning(false);
    }
  }, [
    evalComparisonBackend,
    evalComparisonBaseModel,
    evalComparisonDryRun,
    evalComparisonManifestPath,
    evalComparisonOutputDir,
    evalComparisonTrainedModelPath,
    handleBuildAnalysisIndex,
    setActionNotice,
    t,
  ]);

  const handleRunBenchmarkVsCerebras = useCallback(async () => {
    setBenchmarkRunning(true);
    try {
      const maxSamples = parsePositiveInteger(benchmarkMaxSamples);
      const result = await client.runTrainingBenchmarkVsCerebras({
        tiers: benchmarkTiers.trim() || undefined,
        benchmark: benchmarkKind,
        variants: benchmarkVariants,
        maxSamples: typeof maxSamples === "number" ? maxSamples : undefined,
        dryRun: benchmarkDryRun,
        resultsDb: benchmarkResultsDb.trim() || undefined,
        trainedModelPath: benchmarkTrainedModelPath.trim() || undefined,
        matrixOutputDir: benchmarkMatrixOutputDir.trim() || undefined,
      });
      setBenchmarkResult(result);
      setActionNotice(
        result.exitCode === 0
          ? t("finetuningview.BenchmarkVsCerebrasCompleted")
          : t("finetuningview.BenchmarkVsCerebrasFailed", {
              exitCode: result.exitCode,
            }),
        result.exitCode === 0 ? "success" : "error",
        5200,
      );
      if (!benchmarkDryRun) {
        void handleBuildAnalysisIndex();
      }
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToRunBenchmarkVsCerebras"),
        "error",
        5200,
      );
    } finally {
      setBenchmarkRunning(false);
    }
  }, [
    benchmarkDryRun,
    benchmarkKind,
    benchmarkMatrixOutputDir,
    benchmarkMaxSamples,
    benchmarkResultsDb,
    benchmarkTiers,
    benchmarkTrainedModelPath,
    benchmarkVariants,
    handleBuildAnalysisIndex,
    setActionNotice,
    t,
  ]);

  const handleStageEliza1Bundle = useCallback(async () => {
    setBundleStageRunning(true);
    try {
      const result = await client.stageEliza1Bundle({
        repoId: bundleStageRepoId.trim() || undefined,
        tier: bundleStageTier.trim() || undefined,
        localDir: bundleStageLocalDir.trim() || undefined,
        outputDir: bundleStageOutputDir.trim() || undefined,
        maxBytes: parsePositiveInteger(bundleStageMaxBytes),
        apply: bundleStageApply,
      });
      setBundleStageResult(result);
      setActionNotice(
        result.exitCode === 0
          ? t("finetuningview.Eliza1BundleStageCompleted")
          : t("finetuningview.Eliza1BundleStageFailed", {
              exitCode: result.exitCode,
            }),
        result.exitCode === 0 ? "success" : "error",
        5200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToStageEliza1Bundle"),
        "error",
        5200,
      );
    } finally {
      setBundleStageRunning(false);
    }
  }, [
    bundleStageApply,
    bundleStageLocalDir,
    bundleStageMaxBytes,
    bundleStageOutputDir,
    bundleStageRepoId,
    bundleStageTier,
    setActionNotice,
    t,
  ]);

  const handleIngestHuggingFaceDataset = useCallback(async () => {
    setHfIngestRunning(true);
    try {
      const files = hfFiles
        .split(/\r?\n|,/)
        .map((file) => file.trim())
        .filter(Boolean);
      const result = await client.ingestHuggingFaceTrainingDataset({
        repoId: hfRepoId.trim() || undefined,
        revision: hfRevision.trim() || undefined,
        files: files.length > 0 ? files : undefined,
        outputDir: hfOutputDir.trim() || undefined,
        dryRun: hfDryRun,
      });
      setHfIngestResult(result);
      setActionNotice(
        t("finetuningview.IngestedHuggingFaceDatasetMessage", {
          files: result.manifest.counts.files ?? result.manifest.files.length,
          rows: result.manifest.counts.jsonlRows ?? 0,
        }),
        "success",
        5200,
      );
      if (!hfDryRun) {
        void handleBuildAnalysisIndex();
      }
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToIngestHuggingFaceDataset"),
        "error",
        5200,
      );
    } finally {
      setHfIngestRunning(false);
    }
  }, [
    handleBuildAnalysisIndex,
    hfDryRun,
    hfFiles,
    hfOutputDir,
    hfRepoId,
    hfRevision,
    setActionNotice,
    t,
  ]);

  const handleRunActionBenchmark = useCallback(async () => {
    setActionBenchmarkRunning(true);
    try {
      const result = await client.runTrainingActionBenchmark({
        filter: actionBenchmarkFilter.trim() || undefined,
        runsPerCase: parsePositiveInteger(actionBenchmarkRunsPerCase),
        outputDir: actionBenchmarkOutputDir.trim() || undefined,
        provider: actionBenchmarkProvider.trim() || undefined,
        modelId: actionBenchmarkModelId.trim() || undefined,
        runtimeModel: actionBenchmarkRuntimeModel.trim() || undefined,
        baseUrl: actionBenchmarkBaseUrl.trim() || undefined,
        variant: actionBenchmarkVariant,
        tier: actionBenchmarkTier.trim() || undefined,
        benchmark: actionBenchmarkMatrixBenchmark.trim() || undefined,
        datasetVersion: actionBenchmarkDatasetVersion.trim() || undefined,
        useMocks: actionBenchmarkUseMocks,
        forceTrajectoryCapture: actionBenchmarkCapture,
        dryRun: actionBenchmarkDryRun,
      });
      setActionBenchmarkResult(result);
      setActionNotice(
        result.exitCode === 0
          ? t("finetuningview.ActionBenchmarkCompleted")
          : t("finetuningview.ActionBenchmarkFailed", {
              exitCode: result.exitCode,
            }),
        result.exitCode === 0 ? "success" : "error",
        5200,
      );
      if (!actionBenchmarkDryRun) {
        void handleBuildAnalysisIndex();
      }
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToRunActionBenchmark"),
        "error",
        5200,
      );
    } finally {
      setActionBenchmarkRunning(false);
    }
  }, [
    actionBenchmarkCapture,
    actionBenchmarkDryRun,
    actionBenchmarkFilter,
    actionBenchmarkDatasetVersion,
    actionBenchmarkMatrixBenchmark,
    actionBenchmarkModelId,
    actionBenchmarkBaseUrl,
    actionBenchmarkOutputDir,
    actionBenchmarkProvider,
    actionBenchmarkRunsPerCase,
    actionBenchmarkRuntimeModel,
    actionBenchmarkTier,
    actionBenchmarkUseMocks,
    actionBenchmarkVariant,
    handleBuildAnalysisIndex,
    setActionNotice,
    t,
  ]);

  const handleRunFeedGeneration = useCallback(async () => {
    setFeedGenerationRunning(true);
    try {
      const result = await client.runFeedTrainingGeneration({
        archetypes: feedArchetypes.trim() || undefined,
        numAgents: parsePositiveInteger(feedNumAgents),
        ticks: parsePositiveInteger(feedTicks),
        parallel: parsePositiveInteger(feedParallel),
        cleanup: feedCleanup,
        dryRun: feedDryRun,
        outputDir: feedOutputDir.trim() || undefined,
      });
      setFeedGenerationResult(result);
      setActionNotice(
        t("finetuningview.FeedGenerationCompleted"),
        "success",
        5200,
      );
      if (!feedDryRun) {
        void handleBuildAnalysisIndex();
      }
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToRunFeedGeneration"),
        "error",
        5200,
      );
    } finally {
      setFeedGenerationRunning(false);
    }
  }, [
    feedArchetypes,
    feedCleanup,
    feedDryRun,
    feedNumAgents,
    feedOutputDir,
    feedParallel,
    feedTicks,
    handleBuildAnalysisIndex,
    setActionNotice,
    t,
  ]);

  const handleRunScenarios = useCallback(async () => {
    setScenarioRunning(true);
    try {
      const result = await client.runTrainingScenarios({
        scenario: scenarioFilter.trim() || undefined,
        outputDir: scenarioOutputDir.trim() || undefined,
        exportNative: scenarioExportNative,
        useDeterministicProxy: scenarioDeterministicProxy,
        dryRun: scenarioDryRun,
      });
      setScenarioResult(result);
      setActionNotice(
        result.exitCode === 0
          ? t("finetuningview.ScenariosCompleted")
          : t("finetuningview.ScenariosFailed", {
              exitCode: result.exitCode,
            }),
        result.exitCode === 0 ? "success" : "error",
        5200,
      );
      if (!scenarioDryRun) {
        void handleBuildAnalysisIndex();
      }
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToRunScenarios"),
        "error",
        5200,
      );
    } finally {
      setScenarioRunning(false);
    }
  }, [
    handleBuildAnalysisIndex,
    scenarioDeterministicProxy,
    scenarioDryRun,
    scenarioExportNative,
    scenarioFilter,
    scenarioOutputDir,
    setActionNotice,
    t,
  ]);

  const handleStartJob = useCallback(async () => {
    setStartingJob(true);
    try {
      const options: StartTrainingOptions = {
        datasetId: selectedDatasetId || undefined,
        backend: startBackend,
        model: startModel.trim() || undefined,
        iterations: parsePositiveInteger(startIterations),
        batchSize: parsePositiveInteger(startBatchSize),
        learningRate: parsePositiveFloat(startLearningRate),
      };
      const result = await client.startTrainingJob(options);
      setSelectedJobId(result.job.id);
      await Promise.all([loadJobs(), loadStatus()]);
      setActionNotice(
        t("finetuningview.StartedTrainingJobMessage", { id: result.job.id }),
        "success",
        3200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToStartTrainingJob"),
        "error",
        4200,
      );
    } finally {
      setStartingJob(false);
    }
  }, [
    loadJobs,
    loadStatus,
    selectedDatasetId,
    setActionNotice,
    startBackend,
    startBatchSize,
    startIterations,
    startLearningRate,
    startModel,
    t,
  ]);

  const handleCancelJob = useCallback(
    async (jobId: string) => {
      setCancellingJobId(jobId);
      try {
        await client.cancelTrainingJob(jobId);
        await Promise.all([loadJobs(), loadStatus()]);
        setActionNotice(
          t("finetuningview.CancelledJobMessage", { id: jobId }),
          "success",
          2600,
        );
      } catch (err) {
        setActionNotice(
          err instanceof Error
            ? err.message
            : t("finetuningview.FailedToCancelJob", { id: jobId }),
          "error",
          4200,
        );
      } finally {
        setCancellingJobId("");
      }
    },
    [loadJobs, loadStatus, setActionNotice, t],
  );

  const handleImportSelectedModel = useCallback(async () => {
    if (!selectedModel) return;
    const actionId = `import:${selectedModel.id}`;
    setModelAction(actionId);
    try {
      const result = await client.importTrainingModelToOllama(
        selectedModel.id,
        {
          modelName: importModelName.trim() || undefined,
          baseModel: importBaseModel.trim() || undefined,
          ollamaUrl: importOllamaUrl.trim() || undefined,
        },
      );
      await loadModels();
      setActivateProviderModel(
        result.model.ollamaModel ? `ollama/${result.model.ollamaModel}` : "",
      );
      setActionNotice(
        t("finetuningview.ImportedModelToOllamaMessage", {
          id: result.model.id,
          ollamaModel: result.model.ollamaModel
            ? ` as ${result.model.ollamaModel}`
            : "",
        }),
        "success",
        4200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToImportModelToOllama"),
        "error",
        4200,
      );
    } finally {
      setModelAction("");
    }
  }, [
    importBaseModel,
    importModelName,
    importOllamaUrl,
    loadModels,
    selectedModel,
    setActionNotice,
    t,
  ]);

  const handleActivateSelectedModel = useCallback(async () => {
    if (!selectedModel) return;
    const actionId = `activate:${selectedModel.id}`;
    setModelAction(actionId);
    try {
      const result = await client.activateTrainingModel(
        selectedModel.id,
        activateProviderModel.trim() || undefined,
      );
      await loadModels();
      setActionNotice(
        t("finetuningview.ActivatedModelMessage", {
          id: result.modelId,
          providerModel: result.providerModel,
        }),
        "success",
        4200,
      );
      if (result.needsRestart) {
        const shouldRestart = await confirmDesktopAction({
          title: t("finetuningview.RestartAgentTitle"),
          message: t("finetuningview.RestartAgentMessage"),
          confirmLabel: t("finetuningview.Restart"),
          cancelLabel: t("restartbanner.Later"),
          type: "question",
        });
        if (shouldRestart) {
          await handleRestart();
        }
      }
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToActivateModel"),
        "error",
        4200,
      );
    } finally {
      setModelAction("");
    }
  }, [
    activateProviderModel,
    handleRestart,
    loadModels,
    selectedModel,
    setActionNotice,
    t,
  ]);

  const handleBenchmarkSelectedModel = useCallback(async () => {
    if (!selectedModel) return;
    const actionId = `benchmark:${selectedModel.id}`;
    setModelAction(actionId);
    try {
      const result = await client.benchmarkTrainingModel(selectedModel.id);
      await loadModels();
      setActionNotice(
        t("finetuningview.BenchmarkStatusMessage", {
          status: result.status,
          id: selectedModel.id,
        }),
        result.status === "passed" ? "success" : "error",
        4200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToBenchmarkModel"),
        "error",
        4200,
      );
    } finally {
      setModelAction("");
    }
  }, [loadModels, selectedModel, setActionNotice, t]);

  const handleSmokeTestSelectedModel = useCallback(async () => {
    if (!selectedModel) return;
    const actionId = `smoke:${selectedModel.id}`;
    setModelAction(actionId);
    try {
      const result = await client.sendChatRest(
        "Model smoke test. Reply with exactly: MODEL_OK",
      );
      setSmokeResult(result.text);
      setActionNotice(t("finetuningview.SmokeTestCompleted"), "success", 3200);
    } catch (err) {
      setSmokeResult(null);
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToRunSmokeTest"),
        "error",
        4200,
      );
    } finally {
      setModelAction("");
    }
  }, [selectedModel, setActionNotice, t]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useIntervalWhenDocumentVisible(() => {
    void loadStatus();
    void loadJobs();
    void loadModels();
  }, 5000);

  useEffect(() => {
    const unbind = client.onWsEvent(
      "training_event",
      (rawEnvelope: Record<string, unknown>) => {
        const event = asTrainingEvent(
          rawEnvelope as Partial<StreamEventEnvelope>,
        );
        if (!event) return;
        setTrainingEvents((prev) => {
          const merged = [event, ...prev];
          return merged.slice(0, 240);
        });
        if (event.kind !== "job_log") {
          void loadStatus();
          void loadJobs();
          void loadModels();
          if (event.kind === "dataset_built") {
            void loadDatasets();
          }
        }
      },
    );
    return () => {
      unbind();
    };
  }, [loadDatasets, loadJobs, loadModels, loadStatus]);

  const onBuildDataset = useCallback(() => {
    void handleBuildDataset();
  }, [handleBuildDataset]);
  const onRefreshDatasets = useCallback(() => {
    void loadDatasets();
  }, [loadDatasets]);
  const onStartJob = useCallback(() => {
    void handleStartJob();
  }, [handleStartJob]);
  const onRefreshJobs = useCallback(() => {
    void loadJobs();
    void loadStatus();
  }, [loadJobs, loadStatus]);
  const onCancelJob = useCallback(
    (jobId: string) => {
      void handleCancelJob(jobId);
    },
    [handleCancelJob],
  );
  const onImportModel = useCallback(() => {
    void handleImportSelectedModel();
  }, [handleImportSelectedModel]);
  const onActivateModel = useCallback(() => {
    void handleActivateSelectedModel();
  }, [handleActivateSelectedModel]);
  const onBenchmarkModel = useCallback(() => {
    void handleBenchmarkSelectedModel();
  }, [handleBenchmarkSelectedModel]);
  const onSmokeTestModel = useCallback(() => {
    void handleSmokeTestSelectedModel();
  }, [handleSmokeTestSelectedModel]);

  if (pageLoading) {
    return (
      <ContentLayout contentHeader={contentHeader}>
        <div data-testid="fine-tuning-view" className="text-sm text-muted">
          {t("finetuningview.LoadingFineTuning")}
        </div>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout contentHeader={contentHeader}>
      <div data-testid="fine-tuning-view" className="space-y-4 pb-32">
        <section className="px-2 py-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-txt">
                {t("finetuningview.FineTuning")}
              </h2>
            </div>
            <TrainingActionButton
              agentId="action-refresh-all"
              label={t("finetuningview.RefreshAll")}
              group="overview"
              description="Refresh all training status, datasets, jobs, and models"
              onClick={() => {
                void refreshAll();
              }}
            >
              {t("finetuningview.RefreshAll")}
            </TrainingActionButton>
          </div>
          {errorMessage && (
            <div className="mt-3 px-1 py-2 text-sm text-danger">
              {errorMessage}
            </div>
          )}
        </section>

        <section className={FINE_TUNING_SECTION_CLASS}>
          <div className={FINE_TUNING_SECTION_HEADER_CLASS}>
            <div className="text-lg font-semibold text-txt">
              {t("finetuningview.Status")}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3 xl:grid-cols-6">
            <div className={FINE_TUNING_STATUS_CARD_CLASS}>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.Runtime")}
              </div>
              <div className="mt-2 text-base font-semibold text-txt">
                {status?.runtimeAvailable
                  ? t("finetuningview.Ready")
                  : t("finetuningview.Offline")}
              </div>
            </div>
            <div className={FINE_TUNING_STATUS_CARD_CLASS}>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.RunningJobs")}
              </div>
              <div className="mt-2 text-base font-semibold text-txt">
                {status?.runningJobs ?? 0}
              </div>
            </div>
            <div className={FINE_TUNING_STATUS_CARD_CLASS}>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.QueuedJobs")}
              </div>
              <div className="mt-2 text-base font-semibold text-txt">
                {status?.queuedJobs ?? 0}
              </div>
            </div>
            <div className={FINE_TUNING_STATUS_CARD_CLASS}>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.Datasets")}
              </div>
              <div className="mt-2 text-base font-semibold text-txt">
                {status?.datasetCount ?? 0}
              </div>
            </div>
            <div className={FINE_TUNING_STATUS_CARD_CLASS}>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.Models")}
              </div>
              <div className="mt-2 text-base font-semibold text-txt">
                {status?.modelCount ?? 0}
              </div>
            </div>
            <div className={FINE_TUNING_STATUS_CARD_CLASS}>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.FailedJobs")}
              </div>
              <div className="mt-2 text-base font-semibold text-txt">
                {status?.failedJobs ?? 0}
              </div>
            </div>
          </div>
        </section>

        <TrajectoriesSection
          trajectoryList={trajectoryList}
          selectedTrajectory={selectedTrajectory}
          trajectoryLoading={trajectoryLoading}
          publishingTrajectories={publishingTrajectories}
          publishConfigured={publishConfigured}
          onRefresh={() => {
            void loadTrajectories();
          }}
          onSelectTrajectory={(trajectoryId) => {
            void loadTrajectoryDetail(trajectoryId);
          }}
          onPublishTrajectories={() => {
            void handlePublishTrajectories();
          }}
          t={t}
        />

        <section className={FINE_TUNING_SECTION_CLASS}>
          <div className={FINE_TUNING_SECTION_HEADER_CLASS}>
            <div className="text-lg font-semibold text-txt">
              {t("finetuningview.TrainingAnalysisIndex", {
                defaultValue: "Training analysis",
              })}
            </div>
            <div className="flex flex-wrap gap-2">
              <TrainingActionButton
                agentId="action-collect-and-index"
                label={t("finetuningview.CollectAndIndex", {
                  defaultValue: "Collect and index",
                })}
                group="analysis"
                description="Run the full training data collection and build the analysis index"
                disabled={collectionRunning}
                onClick={() => {
                  void handleRunTrainingCollection();
                }}
              >
                {collectionRunning
                  ? t("finetuningview.Collecting", {
                      defaultValue: "Collecting",
                    })
                  : t("finetuningview.CollectAndIndex", {
                      defaultValue: "Collect and index",
                    })}
              </TrainingActionButton>
              <TrainingActionButton
                agentId="action-collection-preflight"
                label="Run collection preflight"
                group="analysis"
                description="Run a preflight check of the training data collection without writing artifacts"
                disabled={collectionPreflightRunning}
                onClick={() => {
                  void handleRunTrainingCollection(true);
                }}
              >
                {collectionPreflightRunning
                  ? "Checking"
                  : "Run collection preflight"}
              </TrainingActionButton>
              <TrainingActionButton
                agentId="action-build-analysis-index"
                label={t("finetuningview.BuildAnalysisIndex", {
                  defaultValue: "Build index",
                })}
                group="analysis"
                description="Build the training analysis index from collected artifacts"
                disabled={analysisBuilding}
                onClick={() => {
                  void handleBuildAnalysisIndex();
                }}
              >
                {analysisBuilding
                  ? t("finetuningview.Indexing", { defaultValue: "Indexing" })
                  : t("finetuningview.BuildAnalysisIndex", {
                      defaultValue: "Build index",
                    })}
              </TrainingActionButton>
              <TrainingActionButton
                agentId="action-build-readiness-report"
                label={t("finetuningview.BuildReadinessReport", {
                  defaultValue: "Readiness report",
                })}
                group="analysis"
                description="Build the training readiness report and surface missing checks"
                disabled={readinessBuilding}
                onClick={() => {
                  void handleBuildReadinessReport();
                }}
              >
                {readinessBuilding
                  ? t("finetuningview.CheckingReadiness", {
                      defaultValue: "Checking",
                    })
                  : t("finetuningview.BuildReadinessReport", {
                      defaultValue: "Readiness report",
                    })}
              </TrainingActionButton>
            </div>
          </div>
          <div className={`${FINE_TUNING_PANEL_CLASS} p-3 text-sm`}>
            <div className="mb-3 pb-2">
              <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <AgentCheckboxField
                  agentId="analysis-probe-endpoints"
                  label="Probe live endpoints"
                  group="analysis"
                  description="Probe live endpoints during the collection preflight"
                  checked={collectionPreflightProbe}
                  onChange={setCollectionPreflightProbe}
                />
                Probe live endpoints
              </div>
            </div>
            <div className="mb-3 pb-2">
              <div className="mb-2 text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                Natural trajectory import
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1 text-xs text-muted md:col-span-2">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    Sanitized JSONL
                  </span>
                  <AgentTextField
                    agentId="natural-sanitized-jsonl"
                    label="Sanitized JSONL path"
                    group="natural-import"
                    description="Path to the sanitized trajectory JSONL file"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={naturalSanitizedJsonlPath}
                    onChange={setNaturalSanitizedJsonlPath}
                    placeholder="/path/to/trajectories.sanitized.jsonl"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted md:col-span-2">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    Raw JSONL
                  </span>
                  <AgentTextField
                    agentId="natural-raw-jsonl"
                    label="Raw JSONL path"
                    group="natural-import"
                    description="Path to the raw trajectory JSONL file"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={naturalRawJsonlPath}
                    onChange={setNaturalRawJsonlPath}
                    placeholder="/path/to/trajectories.raw.jsonl"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    Run ID
                  </span>
                  <AgentTextField
                    agentId="natural-run-id"
                    label="Run ID"
                    group="natural-import"
                    description="Run identifier for the imported trajectories"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={naturalRunId}
                    onChange={setNaturalRunId}
                    placeholder="app-run-1"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    Task buckets
                  </span>
                  <AgentTextField
                    agentId="natural-task-buckets"
                    label="Task buckets"
                    group="natural-import"
                    description="Comma-separated task buckets to import"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={naturalTasks}
                    onChange={setNaturalTasks}
                    placeholder="response,action_planner"
                  />
                </div>
                <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <AgentCheckboxField
                    agentId="natural-include-raw"
                    label="Include raw trajectories"
                    group="natural-import"
                    description="Include raw trajectories in the import"
                    checked={naturalIncludeRaw}
                    onChange={setNaturalIncludeRaw}
                  />
                  Include raw
                </div>
              </div>
            </div>
            {readinessReport ? (
              <div className="mb-3 pb-2">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Readiness")}
                    </div>
                    <div className="mt-1 font-mono text-txt">
                      {readinessReport.report.status}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.ReadyChecks")}
                    </div>
                    <div className="mt-1 font-mono text-xs text-txt">
                      {readinessReport.report.counts.ready ?? 0}/
                      {readinessReport.report.counts.checks ?? 0}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Missing")}
                    </div>
                    <div className="mt-1 font-mono text-xs text-txt">
                      {readinessReport.report.counts.missing ?? 0}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Report")}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {readinessReport.reportPath}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <AgentInlineButton
                    agentId="readiness-open-report"
                    label="Open readiness report"
                    group="readiness"
                    description="Open the readiness report file"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(readinessReport.reportPath),
                      );
                    }}
                  >
                    Open readiness report
                  </AgentInlineButton>
                  {readinessReport.report.analysisIndexHtmlPath ? (
                    <AgentInlineButton
                      agentId="readiness-open-viewer"
                      label="Open readiness viewer"
                      group="readiness"
                      description="Open the readiness analysis viewer"
                      className={FINE_TUNING_ACTION_CLASS}
                      onClick={() => {
                        void openExternalUrl(
                          localViewerUrl(
                            readinessReport.report.analysisIndexHtmlPath,
                          ),
                        );
                      }}
                    >
                      Open readiness viewer
                    </AgentInlineButton>
                  ) : null}
                  <AgentInlineButton
                    agentId="readiness-open-output"
                    label="Open readiness output"
                    group="readiness"
                    description="Open the readiness output directory"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(readinessReport.outputDir),
                      );
                    }}
                  >
                    Open readiness output
                  </AgentInlineButton>
                </div>
                {readinessReport.report.checks.some(
                  (check) => check.status !== "ready",
                ) ? (
                  <div className="mt-3 space-y-2">
                    {readinessReport.report.checks
                      .filter((check) => check.status !== "ready")
                      .slice(0, 5)
                      .map((check) => (
                        <ReadinessCheckRow
                          key={check.id}
                          check={check}
                          readinessActionRunning={readinessActionRunning}
                          onRunRecommendation={handleRunReadinessRecommendation}
                          t={t}
                        />
                      ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {collectionPreflightResult ? (
              <div className="mb-3 pb-2">
                <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                  Collection preflight
                </div>
                <div className="mt-1 break-all font-mono text-xs text-txt">
                  live:{collectionPreflightResult.liveRequired ? "yes" : "no"}{" "}
                  {collectionPreflightResult.checks
                    .map(
                      (check) =>
                        `${check.id}:${check.status}${
                          check.path ? `->${check.path}` : ""
                        }`,
                    )
                    .join(" | ")}
                </div>
              </div>
            ) : null}
            {collectionResult ? (
              <div className="mb-3 grid gap-3 pb-2 md:grid-cols-2 xl:grid-cols-4">
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Collection")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {collectionResult.outputDir}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Manifest")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {collectionResult.manifestPath}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Run summary")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {collectionResult.readmePath}
                  </div>
                  <AgentInlineButton
                    agentId="collection-open-summary"
                    label="Open collection summary"
                    group="collection-result"
                    description="Open the collection run summary"
                    className={`${FINE_TUNING_ACTION_CLASS} mt-2`}
                    onClick={() =>
                      void openExternalUrl(
                        localViewerUrl(collectionResult.readmePath),
                      )
                    }
                  >
                    Open summary
                  </AgentInlineButton>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Steps")}
                  </div>
                  <div className="mt-1 font-mono text-xs text-txt">
                    {collectionResult.manifest.steps
                      .map((step) => `${step.id}:${step.status}`)
                      .join(" ")}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Viewer")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {collectionResult.manifest.analysis.indexHtmlPath}
                  </div>
                  <AgentInlineButton
                    agentId="collection-open-viewer"
                    label="Open collection viewer"
                    group="collection-result"
                    description="Open the collection analysis viewer"
                    className={`${FINE_TUNING_ACTION_CLASS} mt-2`}
                    onClick={() =>
                      void openExternalUrl(
                        localViewerUrl(
                          collectionResult.manifest.analysis.indexHtmlPath,
                        ),
                      )
                    }
                  >
                    Open viewer
                  </AgentInlineButton>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    Collection index
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {collectionResult.collectionIndex.indexHtmlPath}
                  </div>
                  <AgentInlineButton
                    agentId="collection-open-index"
                    label="Open collection index"
                    group="collection-result"
                    description="Open the collection index"
                    className={`${FINE_TUNING_ACTION_CLASS} mt-2`}
                    onClick={() =>
                      void openExternalUrl(
                        localViewerUrl(
                          collectionResult.collectionIndex.indexHtmlPath,
                        ),
                      )
                    }
                  >
                    Open index
                  </AgentInlineButton>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Readiness")}
                  </div>
                  <div className="mt-1 font-mono text-xs text-txt">
                    {collectionResult.manifest.readiness.status}{" "}
                    {collectionResult.manifest.readiness.ready}/
                    {collectionResult.manifest.readiness.ready +
                      collectionResult.manifest.readiness.partial +
                      collectionResult.manifest.readiness.missing}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    Data sources
                  </div>
                  <div className="mt-1 font-mono text-xs text-txt">
                    hf:
                    {
                      collectionResult.manifest.evidence.dataSources
                        .huggingFaceDatasets
                    }{" "}
                    feed:
                    {
                      collectionResult.manifest.evidence.dataSources
                        .feedDatasets
                    }{" "}
                    natural:
                    {
                      collectionResult.manifest.evidence.dataSources
                        .naturalTrajectoryBundles
                    }{" "}
                    scenarios:
                    {
                      collectionResult.manifest.evidence.dataSources
                        .scenarioRuns
                    }{" "}
                    native:
                    {
                      collectionResult.manifest.evidence.dataSources
                        .scenarioNativeDatasets
                    }{" "}
                    tests:
                    {
                      collectionResult.manifest.evidence.dataSources
                        .testTrajectories
                    }{" "}
                    jsonl:
                    {
                      collectionResult.manifest.evidence.dataSources
                        .trainingJsonlDatasets
                    }
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    Eval evidence
                  </div>
                  <div className="mt-1 font-mono text-xs text-txt">
                    evals:
                    {collectionResult.manifest.evidence.evals.evalArtifacts}{" "}
                    matrices:
                    {collectionResult.manifest.evidence.evals.benchmarkMatrices}{" "}
                    models:{collectionResult.manifest.evidence.training.models}
                    {formatModelInventorySummary(
                      collectionResult.manifest.evidence.training
                        .modelInventory,
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    Benchmark evidence
                  </div>
                  <div className="mt-1 font-mono text-xs text-txt">
                    pairs:
                    {
                      collectionResult.manifest.evidence.benchmarks
                        .actionBenchmarkPairs
                    }{" "}
                    sources:
                    {
                      collectionResult.manifest.evidence.benchmarks
                        .actionBenchmarkMatrixSources
                    }{" "}
                    rows:
                    {
                      collectionResult.manifest.evidence.benchmarks
                        .benchmarkRows
                    }{" "}
                    comparisons:
                    {
                      collectionResult.manifest.evidence.benchmarks
                        .benchmarkComparisons
                    }
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    Benchmark tiers
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {collectionResult.manifest.evidence.benchmarks.tiers
                      .length > 0
                      ? collectionResult.manifest.evidence.benchmarks.tiers.join(
                          ",",
                        )
                      : "none"}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    Benchmark readiness
                  </div>
                  <div className="mt-1 font-mono text-xs text-txt">
                    smallest:
                    {
                      collectionResult.manifest.evidence.benchmarkReadiness
                        .smallestTier
                    }{" "}
                    improvement:
                    {
                      collectionResult.manifest.evidence.benchmarkReadiness
                        .baseTrainedImprovement
                    }{" "}
                    all-tier:
                    {
                      collectionResult.manifest.evidence.benchmarkReadiness
                        .allEliza1TierImprovements
                    }{" "}
                    samples:
                    {collectionResult.manifest.evidence.readinessGaps.find(
                      (gap) => gap.id === "readable_source_samples",
                    )?.status ?? "ready"}
                  </div>
                </div>
                {collectionResult.manifest.evidence.preflight ? (
                  <div className="md:col-span-2 xl:col-span-4">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      Live preflight
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      live:
                      {collectionResult.manifest.evidence.preflight.liveRequired
                        ? "yes"
                        : "no"}{" "}
                      {collectionResult.manifest.evidence.preflight.checks
                        .map(
                          (check) =>
                            `${check.id}:${check.status}${
                              check.path ? `->${check.path}` : ""
                            }`,
                        )
                        .join(" | ")}
                    </div>
                  </div>
                ) : null}
                {collectionResult.manifest.evidence.artifactLinks.length > 0 ? (
                  <div className="md:col-span-2 xl:col-span-4">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      Evidence artifacts
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {collectionResult.manifest.evidence.artifactLinks
                        .slice(0, 8)
                        .map(
                          (artifact) =>
                            `${artifact.category}:${artifact.title} -> ${artifact.path}`,
                        )
                        .join(" | ")}
                    </div>
                  </div>
                ) : null}
                {collectionResult.manifest.evidence.stepArtifacts?.length ? (
                  <div className="md:col-span-2 xl:col-span-4">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      Step artifact outputs
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {collectionResult.manifest.evidence.stepArtifacts
                        .flatMap((step) =>
                          step.paths
                            .slice(0, 3)
                            .map(
                              (path) =>
                                `${step.stepId}:${path.label}->${path.path}${
                                  step.command?.length
                                    ? ` cmd:${step.command.join(" ")}`
                                    : ""
                                }${
                                  step.stdout ? ` stdout:${step.stdout}` : ""
                                }${step.stderr ? ` stderr:${step.stderr}` : ""}`,
                            ),
                        )
                        .slice(0, 8)
                        .join(" | ")}
                    </div>
                  </div>
                ) : null}
                {collectionResult.manifest.evidence.feed?.runs.length ? (
                  <div className="md:col-span-2 xl:col-span-4">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      Feed generation evidence
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {collectionResult.manifest.evidence.feed.runs
                        .slice(0, 4)
                        .map(
                          (run) =>
                            `${run.sourceKind ?? run.schema ?? "feed"} ${
                              run.archetype ?? "all"
                            } trajectories:${run.trajectories ?? "n/a"} ticks:${
                              run.totalTicks ?? "n/a"
                            } errors:${run.errors ?? "n/a"} -> ${run.path}`,
                        )
                        .join(" | ")}
                    </div>
                  </div>
                ) : null}
                {collectionResult.manifest.evidence.feed?.trajectorySamples
                  .length ? (
                  <div className="md:col-span-2 xl:col-span-4">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      Feed trajectory samples
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {collectionResult.manifest.evidence.feed.trajectorySamples
                        .slice(0, 5)
                        .map(
                          (sample) =>
                            `${sample.trajectoryId ?? "trajectory"} ${
                              sample.archetype ?? "archetype"
                            } scenario:${sample.scenarioId ?? "n/a"} score:${
                              sample.score ?? "n/a"
                            } steps:${sample.steps ?? "n/a"} first:${
                              sample.firstStep ?? "n/a"
                            } input:${sample.firstInput ?? "n/a"} output:${
                              sample.firstOutput ?? "n/a"
                            }`,
                        )
                        .join(" | ")}
                    </div>
                  </div>
                ) : null}
                {collectionResult.manifest.evidence.sourceSamples &&
                Object.values(
                  collectionResult.manifest.evidence.sourceSamples,
                ).flat().length > 0 ? (
                  <div className="md:col-span-2 xl:col-span-4">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      Collection source samples
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {Object.entries(
                        collectionResult.manifest.evidence.sourceSamples,
                      )
                        .flatMap(([category, samples]) =>
                          samples.slice(0, 2).map((sample) => {
                            const input =
                              typeof sample.input === "string"
                                ? sample.input
                                : JSON.stringify(sample.input);
                            const output =
                              typeof sample.output === "string"
                                ? sample.output
                                : JSON.stringify(sample.output);
                            return `${category}:${
                              sample.trajectoryId ?? sample.title
                            } task:${sample.task ?? "n/a"} model:${
                              sample.model ?? "n/a"
                            } input:${input ?? "n/a"} output:${output ?? "n/a"}`;
                          }),
                        )
                        .slice(0, 8)
                        .join(" | ")}
                    </div>
                  </div>
                ) : null}
                {collectionResult.manifest.evidence.evals.comparisonInventory
                  ?.length ? (
                  <div className="md:col-span-2 xl:col-span-4">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      Eval comparison evidence
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {collectionResult.manifest.evidence.evals.comparisonInventory
                        .slice(0, 5)
                        .map(
                          (comparison) =>
                            `${comparison.baseModel ?? "base"} -> ${
                              comparison.trainedModel ?? "trained"
                            } backend:${
                              comparison.backend ?? "n/a"
                            } base:${comparison.baseScore ?? "n/a"} trained:${
                              comparison.trainedScore ?? "n/a"
                            } improvement:${
                              comparison.improvementPercent ?? "n/a"
                            }% latency:${
                              comparison.baseLatencyMs ?? "n/a"
                            }ms->${comparison.trainedLatencyMs ?? "n/a"}ms report:${
                              comparison.reportPath ?? comparison.path
                            }`,
                        )
                        .join(" | ")}
                    </div>
                  </div>
                ) : null}
                {collectionResult.manifest.evidence.benchmarks
                  .improvementComparisons.length > 0 ? (
                  <div className="md:col-span-2 xl:col-span-4">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      Benchmark improvement
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {collectionResult.manifest.evidence.benchmarks.improvementComparisons
                        .slice(0, 5)
                        .map(
                          (comparison) =>
                            `${comparison.tier ?? "tier"} ${
                              comparison.benchmark ?? "benchmark"
                            } base:${comparison.baseScore ?? "n/a"} trained:${
                              comparison.trainedScore ?? "n/a"
                            } improvement:${
                              comparison.improvementPercent ?? "n/a"
                            }% evidence:${
                              comparison.modelBacked
                                ? "model-backed"
                                : "partial"
                            }`,
                        )
                        .join(" | ")}
                    </div>
                  </div>
                ) : null}
                <div className="md:col-span-2 xl:col-span-4">
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    Baseline progression
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    order:
                    {collectionResult.manifest.evidence.benchmarks.baselineProgress.tierOrder.join(
                      " -> ",
                    )}{" "}
                    established:
                    {collectionResult.manifest.evidence.benchmarks.baselineProgress.establishedTiers.join(
                      ",",
                    ) || "none"}{" "}
                    next:
                    {collectionResult.manifest.evidence.benchmarks
                      .baselineProgress.nextTier ?? "none"}{" "}
                    remaining:
                    {collectionResult.manifest.evidence.benchmarks.baselineProgress.remainingTiers.join(
                      ",",
                    ) || "none"}
                  </div>
                </div>
                {collectionResult.manifest.evidence.benchmarks.caseSamples
                  ?.length ? (
                  <div className="md:col-span-2 xl:col-span-4">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      Benchmark case samples
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {collectionResult.manifest.evidence.benchmarks.caseSamples
                        .slice(0, 5)
                        .map(
                          (sample) =>
                            `${sample.tier ?? "tier"} ${
                              sample.variant ?? "variant"
                            } ${sample.caseId ?? "case"} pass:${
                              sample.pass
                            } input:${sample.prompt ?? "n/a"} expected:${
                              sample.expectedAction ?? "n/a"
                            } actual:${sample.actualAction ?? "n/a"} output:${
                              sample.response ?? "n/a"
                            } trajectory:${sample.trajectoryPath ?? "n/a"}`,
                        )
                        .join(" | ")}
                    </div>
                  </div>
                ) : null}
                {collectionResult.manifest.evidence.readinessGaps.length > 0 ? (
                  <div className="md:col-span-2 xl:col-span-4">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      Readiness gaps
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {collectionResult.manifest.evidence.readinessGaps
                        .slice(0, 5)
                        .map(
                          (gap) =>
                            `${gap.id}:${gap.status}${
                              gap.recommendedCapability
                                ? ` -> ${gap.recommendedCapability}`
                                : ""
                            }`,
                        )
                        .join(" | ")}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {collectionHistory ? (
              <div className="mb-3 pb-2">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      Saved collection runs
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-muted">
                      {collectionHistory.root}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-muted">
                      {collectionHistory.indexHtmlPath}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <AgentInlineButton
                      agentId="collection-history-refresh"
                      label="Refresh collection runs"
                      group="collection-history"
                      description="Reload the saved collection runs list"
                      className={FINE_TUNING_ACTION_CLASS}
                      disabled={collectionHistoryLoading}
                      onClick={() => {
                        void loadCollectionHistory();
                      }}
                    >
                      {collectionHistoryLoading ? "Refreshing" : "Refresh runs"}
                    </AgentInlineButton>
                    <AgentInlineButton
                      agentId="collection-history-open-index"
                      label="Open collection runs index"
                      group="collection-history"
                      description="Open the saved collection runs index"
                      className={FINE_TUNING_ACTION_CLASS}
                      onClick={() =>
                        void openExternalUrl(
                          localViewerUrl(collectionHistory.indexHtmlPath),
                        )
                      }
                    >
                      Open collection index
                    </AgentInlineButton>
                  </div>
                </div>
                {collectionHistory.collections.length > 0 ? (
                  <div className="grid gap-2">
                    {collectionHistory.collections.slice(0, 5).map((run) => (
                      <div key={run.manifestPath} className="p-2">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="break-all font-mono text-xs text-txt">
                              {run.generatedAt} {run.readinessStatus} ready:
                              {run.readiness.ready} partial:
                              {run.readiness.partial} missing:
                              {run.readiness.missing}
                            </div>
                            <div className="mt-1 break-all font-mono text-xs text-muted">
                              {run.outputDir}
                            </div>
                            <div className="mt-1 break-all font-mono text-xs text-muted">
                              artifacts:{run.artifactCount} steps:
                              {run.stepCounts.succeeded ?? 0} ok/
                              {run.stepCounts.failed ?? 0} failed sources hf:
                              {run.dataSources.huggingFaceDatasets} feed:
                              {run.dataSources.feedDatasets} natural:
                              {run.dataSources.naturalTrajectoryBundles} cases:
                              {run.benchmarks.caseSamples} comparisons:
                              {run.benchmarks.benchmarkComparisons} tiers:
                              {run.benchmarks.tiers.join(",") || "n/a"}
                              {run.benchmarks.comparisonInventory?.length
                                ? ` ${run.benchmarks.comparisonInventory
                                    .slice(0, 2)
                                    .map(
                                      (comparison) =>
                                        `${comparison.tier ?? "tier"} ${
                                          comparison.benchmark ?? "benchmark"
                                        } base:${
                                          comparison.baseScore ?? "n/a"
                                        } trained:${
                                          comparison.trainedScore ?? "n/a"
                                        } reference:${
                                          comparison.referenceScore ?? "n/a"
                                        } improvement:${
                                          comparison.improvementPercent ?? "n/a"
                                        }% vs-reference:${
                                          comparison.trainedVsReferencePercent ??
                                          "n/a"
                                        }% ${
                                          comparison.dryRun
                                            ? "dry-run"
                                            : comparison.modelBacked
                                              ? "model-backed"
                                              : comparison.useMocks
                                                ? "mocked"
                                                : "unverified"
                                        }`,
                                    )
                                    .join(" ")}`
                                : ""}{" "}
                              evals:{run.evals?.evalArtifacts ?? 0}{" "}
                              eval-comparisons:
                              {run.evals?.evalComparisons ?? 0}
                              {run.evals?.comparisonInventory?.length
                                ? ` ${run.evals.comparisonInventory
                                    .slice(0, 2)
                                    .map(
                                      (comparison) =>
                                        `${comparison.baseModel ?? "base"}->${
                                          comparison.trainedModel ?? "trained"
                                        } improvement:${
                                          comparison.improvementPercent ?? "n/a"
                                        }%`,
                                    )
                                    .join(" ")}`
                                : ""}
                            </div>
                            <div className="mt-1 break-all font-mono text-xs text-muted">
                              baseline established:
                              {run.benchmarks.baselineProgress.establishedTiers.join(
                                ",",
                              ) || "none"}{" "}
                              next:
                              {run.benchmarks.baselineProgress.nextTier ??
                                "none"}{" "}
                              remaining:
                              {run.benchmarks.baselineProgress.remainingTiers.join(
                                ",",
                              ) || "none"}
                            </div>
                            {run.training ? (
                              <div className="mt-1 break-all font-mono text-xs text-muted">
                                models:{run.training.models} training-runs:
                                {run.training.trainingRuns} inventory:
                                {run.training.modelInventory.length}
                                {run.training.modelInventory.length
                                  ? ` ${run.training.modelInventory
                                      .slice(0, 2)
                                      .map(
                                        (model) =>
                                          `${model.tier ?? "tier"} ${
                                            model.variant ?? "variant"
                                          } ${model.model ?? "model"} base:${
                                            model.baseModel ?? "n/a"
                                          } score:${
                                            model.baseEvalScore ?? "n/a"
                                          }->${
                                            model.trainedEvalScore ?? "n/a"
                                          } output:${
                                            model.outputPath ?? "n/a"
                                          } improvement:${
                                            model.evalImprovementPercent ??
                                            "n/a"
                                          }%`,
                                      )
                                      .join(" ")}`
                                  : ""}
                              </div>
                            ) : null}
                            {run.readinessGaps?.length ? (
                              <>
                                <div className="mt-1 break-all font-mono text-xs text-muted">
                                  gaps:{" "}
                                  {run.readinessGaps
                                    .slice(0, 4)
                                    .map(
                                      (gap) =>
                                        `${gap.id}:${gap.status}${
                                          gap.recommendedCapability
                                            ? `->${gap.recommendedCapability}`
                                            : ""
                                        }`,
                                    )
                                    .join(" | ")}
                                </div>
                                {run.readinessGaps.some(
                                  (gap) => gap.recommendedCapability,
                                ) ? (
                                  <div className="mt-2 flex flex-wrap gap-1">
                                    {run.readinessGaps
                                      .filter(
                                        (gap) => gap.recommendedCapability,
                                      )
                                      .slice(0, 4)
                                      .map((gap) => (
                                        <AgentInlineButton
                                          key={`${run.manifestPath}:${gap.id}:${gap.recommendedCapability}`}
                                          agentId={`history-gap-${run.manifestPath}-${gap.id}`}
                                          label={`Run recommendation for ${gap.id}`}
                                          group="collection-history"
                                          description={`Run the recommended action ${gap.recommendedCapability} for gap ${gap.id}`}
                                          title={`${gap.id}: ${gap.recommendedCapability}`}
                                          className={FINE_TUNING_ACTION_CLASS}
                                          disabled={
                                            readinessActionRunning ===
                                            `history:${gap.id}`
                                          }
                                          onClick={() => {
                                            const capability =
                                              gap.recommendedCapability;
                                            if (!capability) return;
                                            void handleRunReadinessRecommendation(
                                              `history:${gap.id}`,
                                              {
                                                label: gap.label,
                                                capability,
                                                params:
                                                  gap.recommendedParams ?? {},
                                              },
                                            );
                                          }}
                                        >
                                          Run {gap.id}
                                        </AgentInlineButton>
                                      ))}
                                  </div>
                                ) : null}
                              </>
                            ) : null}
                            {run.coverage ? (
                              <div className="mt-1 break-all font-mono text-xs text-muted">
                                coverage samples:
                                {run.coverage.readableSamples.total} hf:
                                {run.coverage.dataSources.huggingFace} feed:
                                {run.coverage.dataSources.feed} natural:
                                {run.coverage.dataSources.natural} scenarios:
                                {run.coverage.dataSources.scenarios} tests:
                                {run.coverage.dataSources.tests} jsonl:
                                {run.coverage.dataSources.trainingJsonl}{" "}
                                scored-evals:
                                {run.coverage.evals.scoredComparisons}/
                                {run.coverage.evals.comparisons} scored-bench:
                                {run.coverage.benchmarks.scoredComparisons}/
                                {run.coverage.benchmarks.comparisons} all-tiers:
                                {run.coverage.benchmarks.allEliza1TiersCovered
                                  ? "yes"
                                  : "no"}
                              </div>
                            ) : null}
                            {run.sourceSamples &&
                            Object.values(run.sourceSamples).flat().length >
                              0 ? (
                              <div className="mt-1 break-all font-mono text-xs text-muted">
                                source samples:{" "}
                                {Object.entries(run.sourceSamples)
                                  .flatMap(([category, samples]) =>
                                    samples.slice(0, 2).map((sample) => {
                                      const input = compactDisplayValue(
                                        sample.input,
                                      );
                                      const output = compactDisplayValue(
                                        sample.output,
                                      );
                                      return `${category}:${
                                        sample.trajectoryId ??
                                        sample.scenarioId ??
                                        sample.title
                                      } task:${
                                        sample.task ??
                                        sample.sourceKind ??
                                        "n/a"
                                      } input:${input || "n/a"} output:${
                                        output || "n/a"
                                      }`;
                                    }),
                                  )
                                  .slice(0, 8)
                                  .join(" | ")}
                              </div>
                            ) : null}
                            {run.sourceArtifacts?.length ? (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {run.sourceArtifacts
                                  .slice(0, 6)
                                  .map((artifact) => (
                                    <AgentInlineButton
                                      key={`${artifact.category}:${artifact.path}`}
                                      agentId={`history-source-artifact-${run.manifestPath}-${artifact.category}-${artifact.path}`}
                                      label={`Open source artifact ${artifact.category}:${artifact.title}`}
                                      group="collection-history"
                                      description={`Open the source artifact ${artifact.path}`}
                                      variant="ghost"
                                      className={FINE_TUNING_ACTION_CLASS}
                                      onClick={() =>
                                        void openExternalUrl(
                                          localViewerUrl(artifact.path),
                                        )
                                      }
                                    >
                                      {artifact.category}:{artifact.title}
                                    </AgentInlineButton>
                                  ))}
                              </div>
                            ) : null}
                            {run.evidenceArtifacts?.length ? (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {run.evidenceArtifacts
                                  .slice(0, 6)
                                  .map((artifact) => (
                                    <AgentInlineButton
                                      key={`${artifact.category}:${artifact.path}`}
                                      agentId={`history-evidence-artifact-${run.manifestPath}-${artifact.category}-${artifact.path}`}
                                      label={`Open evidence artifact ${artifact.category}:${artifact.title}`}
                                      group="collection-history"
                                      description={`Open the evidence artifact ${artifact.path}`}
                                      variant="ghost"
                                      className={FINE_TUNING_ACTION_CLASS}
                                      onClick={() =>
                                        void openExternalUrl(
                                          localViewerUrl(artifact.path),
                                        )
                                      }
                                    >
                                      {artifact.category}:{artifact.title}
                                    </AgentInlineButton>
                                  ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <AgentInlineButton
                              agentId={`history-run-viewer-${run.manifestPath}`}
                              label={`Open saved viewer for ${run.generatedAt}`}
                              group="collection-history"
                              description="Open the saved collection run viewer"
                              className={FINE_TUNING_ACTION_CLASS}
                              onClick={() =>
                                void openExternalUrl(
                                  localViewerUrl(run.analysisIndexHtmlPath),
                                )
                              }
                            >
                              Open saved viewer
                            </AgentInlineButton>
                            <AgentInlineButton
                              agentId={`history-run-summary-${run.manifestPath}`}
                              label={`Open saved summary for ${run.generatedAt}`}
                              group="collection-history"
                              description="Open the saved collection run summary"
                              className={FINE_TUNING_ACTION_CLASS}
                              onClick={() =>
                                void openExternalUrl(
                                  localViewerUrl(run.readmePath),
                                )
                              }
                            >
                              Open saved summary
                            </AgentInlineButton>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="font-mono text-xs text-muted">None</div>
                )}
              </div>
            ) : null}
            {analysisIndex ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Artifacts")}
                  </div>
                  <div className="mt-1 font-mono text-txt">
                    {analysisIndex.manifest.artifacts.length}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Viewer")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {analysisIndex.indexHtmlPath}
                  </div>
                  <AgentInlineButton
                    agentId="analysis-open-viewer"
                    label="Open analysis viewer"
                    group="analysis"
                    description="Open the analysis index viewer"
                    className={`${FINE_TUNING_ACTION_CLASS} mt-2`}
                    onClick={() =>
                      void openExternalUrl(
                        localViewerUrl(analysisIndex.indexHtmlPath),
                      )
                    }
                  >
                    Open viewer
                  </AgentInlineButton>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Manifest")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {analysisIndex.manifestPath}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Output")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {analysisIndex.outputDir}
                  </div>
                </div>
                {analysisCoverage ? (
                  <>
                    <div>
                      <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                        Source coverage
                      </div>
                      <div className="mt-1 font-mono text-xs text-txt">
                        hf:{analysisCoverage.dataSources.huggingFace} feed:
                        {analysisCoverage.dataSources.feed} natural:
                        {analysisCoverage.dataSources.natural} scenarios:
                        {analysisCoverage.dataSources.scenarios} tests:
                        {analysisCoverage.dataSources.tests} jsonl:
                        {analysisCoverage.dataSources.trainingJsonl}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                        Readable samples
                      </div>
                      <div className="mt-1 font-mono text-xs text-txt">
                        total:{analysisCoverage.readableSamples.total} hf:
                        {analysisCoverage.readableSamples.huggingFace} feed:
                        {analysisCoverage.readableSamples.feed} natural:
                        {analysisCoverage.readableSamples.natural} scenarios:
                        {analysisCoverage.readableSamples.scenarios} tests:
                        {analysisCoverage.readableSamples.tests} jsonl:
                        {analysisCoverage.readableSamples.trainingJsonl}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                        Eval coverage
                      </div>
                      <div className="mt-1 font-mono text-xs text-txt">
                        evals:{analysisCoverage.evals} matrices:
                        {analysisCoverage.benchmarkMatrices} models:
                        {analysisCoverage.models}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                        Benchmark model stats
                      </div>
                      <div className="mt-1 break-all font-mono text-xs text-txt">
                        models:
                        {analysisCoverage.benchmarkModelStats.modelCount} best:
                        {analysisCoverage.benchmarkModelStats.bestModelId ??
                          "none"}
                        {analysisCoverage.benchmarkModelStats
                          .bestAverageScore !== null
                          ? ` avg:${analysisCoverage.benchmarkModelStats.bestAverageScore}`
                          : ""}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                        Eliza-1 tier coverage
                      </div>
                      <div className="mt-1 break-all font-mono text-xs text-txt">
                        {analysisCoverage.allEliza1TiersCovered
                          ? "all tiers covered"
                          : "partial"}{" "}
                        {analysisCoverage.benchmarkTierCoverage
                          .map(
                            (tier) =>
                              `${tier.tier}:${
                                tier.hasBase ? "base" : "-"
                              }/${tier.hasTrained ? "trained" : "-"}/${
                                tier.hasReference ? "ref" : "-"
                              }/${tier.hasImprovement ? "improvement" : "-"}`,
                          )
                          .join(" ")}
                      </div>
                    </div>
                    {analysisCoverage.benchmarkComparisons.length > 0 ? (
                      <div className="md:col-span-2 xl:col-span-4">
                        <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                          Analysis benchmark improvement
                        </div>
                        <div className="mt-1 break-all font-mono text-xs text-txt">
                          {analysisCoverage.benchmarkComparisons
                            .slice(0, 5)
                            .map(
                              (comparison) =>
                                `${comparison.tier ?? "tier"} ${
                                  comparison.benchmark ?? "benchmark"
                                } base:${
                                  comparison.baseScore ?? "n/a"
                                } trained:${
                                  comparison.trainedScore ?? "n/a"
                                } reference:${
                                  comparison.referenceScore ?? "n/a"
                                } improvement:${
                                  comparison.improvementPercent ?? "n/a"
                                }% vs-ref:${
                                  comparison.trainedVsReferencePercent ?? "n/a"
                                }%`,
                            )
                            .join(" | ")}
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : (
              <div className="text-xs text-muted">
                {t("finetuningview.NoAnalysisIndexBuilt")}
              </div>
            )}
          </div>
          <div className={`${FINE_TUNING_PANEL_CLASS} mt-4 p-3 text-sm`}>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.HuggingFaceRepo")}
                  </span>
                  <AgentTextField
                    agentId="hf-repo-id"
                    label="HuggingFace repo"
                    group="hf-ingest"
                    description="HuggingFace dataset repo id to ingest"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={hfRepoId}
                    onChange={setHfRepoId}
                    placeholder="elizaos/eliza-1-training"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Revision")}
                  </span>
                  <AgentTextField
                    agentId="hf-revision"
                    label="HuggingFace revision"
                    group="hf-ingest"
                    description="Dataset revision/branch to ingest"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={hfRevision}
                    onChange={setHfRevision}
                    placeholder="main"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted md:col-span-2">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Output")}
                  </span>
                  <AgentTextField
                    agentId="hf-output-dir"
                    label="HuggingFace output directory"
                    group="hf-ingest"
                    description="Output directory for the ingested dataset"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={hfOutputDir}
                    onChange={setHfOutputDir}
                    placeholder="default"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted md:col-span-2 xl:col-span-4">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Files")}
                  </span>
                  <AgentTextAreaField
                    agentId="hf-files"
                    label="HuggingFace files"
                    group="hf-ingest"
                    description="Newline-separated dataset files to ingest"
                    className="min-h-24 w-full border-b border-border/60 bg-transparent px-3 py-2 font-mono text-xs text-txt outline-none focus:border-accent"
                    value={hfFiles}
                    onChange={setHfFiles}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <AgentCheckboxField
                    agentId="hf-dry-run"
                    label="HuggingFace ingest dry run"
                    group="hf-ingest"
                    description="Run the HuggingFace ingest as a dry run"
                    checked={hfDryRun}
                    onChange={setHfDryRun}
                  />
                  {t("finetuningview.DryRun")}
                </div>
                <TrainingActionButton
                  agentId="action-ingest-hf-dataset"
                  label={t("finetuningview.IngestHuggingFaceDataset")}
                  group="huggingface"
                  description="Ingest the configured HuggingFace dataset files into a training dataset"
                  disabled={hfIngestRunning}
                  onClick={() => {
                    void handleIngestHuggingFaceDataset();
                  }}
                >
                  {hfIngestRunning
                    ? t("finetuningview.Ingesting")
                    : t("finetuningview.IngestHuggingFaceDataset")}
                </TrainingActionButton>
              </div>
            </div>
            {hfIngestResult && (
              <>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Files")}
                    </div>
                    <div className="mt-1 font-mono text-txt">
                      {hfIngestResult.manifest.counts.files ??
                        hfIngestResult.manifest.files.length}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Rows")}
                    </div>
                    <div className="mt-1 font-mono text-txt">
                      {hfIngestResult.manifest.counts.jsonlRows ?? 0}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Manifest")}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {hfIngestResult.manifestPath}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Output")}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {hfIngestResult.outputDir}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <AgentInlineButton
                    agentId="hf-open-manifest"
                    label="Open HF manifest"
                    group="hf-ingest"
                    description="Open the HuggingFace ingest manifest"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(hfIngestResult.manifestPath),
                      );
                    }}
                  >
                    Open HF manifest
                  </AgentInlineButton>
                  <AgentInlineButton
                    agentId="hf-open-output"
                    label="Open HF output"
                    group="hf-ingest"
                    description="Open the HuggingFace ingest output directory"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(hfIngestResult.outputDir),
                      );
                    }}
                  >
                    Open HF output
                  </AgentInlineButton>
                </div>
              </>
            )}
          </div>
          <div className={`${FINE_TUNING_PANEL_CLASS} mt-4 p-3 text-sm`}>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Archetypes")}
                  </span>
                  <AgentTextField
                    agentId="feed-archetypes"
                    label="Feed archetypes"
                    group="feed-gen"
                    description="Comma-separated archetypes for feed generation"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={feedArchetypes}
                    onChange={setFeedArchetypes}
                    placeholder="trader"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Agents")}
                  </span>
                  <AgentTextField
                    agentId="feed-num-agents"
                    label="Feed agents"
                    group="feed-gen"
                    description="Number of agents for feed generation"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={feedNumAgents}
                    onChange={setFeedNumAgents}
                    type="number"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Ticks")}
                  </span>
                  <AgentTextField
                    agentId="feed-ticks"
                    label="Feed ticks"
                    group="feed-gen"
                    description="Number of simulation ticks for feed generation"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={feedTicks}
                    onChange={setFeedTicks}
                    type="number"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Parallel")}
                  </span>
                  <AgentTextField
                    agentId="feed-parallel"
                    label="Feed parallelism"
                    group="feed-gen"
                    description="Parallelism for feed generation"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={feedParallel}
                    onChange={setFeedParallel}
                    type="number"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Output")}
                  </span>
                  <AgentTextField
                    agentId="feed-output-dir"
                    label="Feed output directory"
                    group="feed-gen"
                    description="Output directory for generated feed trajectories"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={feedOutputDir}
                    onChange={setFeedOutputDir}
                    placeholder="default"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <AgentCheckboxField
                    agentId="feed-cleanup"
                    label="Feed cleanup"
                    group="feed-gen"
                    description="Clean up intermediate feed artifacts"
                    checked={feedCleanup}
                    onChange={setFeedCleanup}
                  />
                  {t("finetuningview.Cleanup")}
                </div>
                <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <AgentCheckboxField
                    agentId="feed-dry-run"
                    label="Feed generation dry run"
                    group="feed-gen"
                    description="Run feed generation as a dry run"
                    checked={feedDryRun}
                    onChange={setFeedDryRun}
                  />
                  {t("finetuningview.DryRun")}
                </div>
                <TrainingActionButton
                  agentId="action-generate-feed-trajectories"
                  label={t("finetuningview.GenerateFeedTrajectories")}
                  group="feed"
                  description="Generate feed simulation trajectories for the configured archetypes"
                  disabled={feedGenerationRunning}
                  onClick={() => {
                    void handleRunFeedGeneration();
                  }}
                >
                  {feedGenerationRunning
                    ? t("finetuningview.Generating")
                    : t("finetuningview.GenerateFeedTrajectories")}
                </TrainingActionButton>
              </div>
            </div>
            {feedGenerationResult && (
              <>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.ExitCode")}
                    </div>
                    <div className="mt-1 font-mono text-txt">
                      {feedGenerationResult.exitCode}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Output")}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {feedGenerationResult.outputDir}
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Command")}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {feedGenerationResult.command.join(" ")}
                    </div>
                  </div>
                  {feedGenerationResult.artifacts.length > 0 ? (
                    <div className="md:col-span-2 xl:col-span-4">
                      <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                        Feed artifacts
                      </div>
                      <div className="mt-1 break-all font-mono text-xs text-txt">
                        {feedGenerationResult.artifacts
                          .map(
                            (artifact) =>
                              `${artifact.schema ?? "feed"}${
                                artifact.sourceKind
                                  ? ` source:${artifact.sourceKind}`
                                  : ""
                              } trajectories:${
                                artifact.trajectories ?? "n/a"
                              } manifest:${artifact.manifestPath}${
                                artifact.exportPath
                                  ? ` export:${artifact.exportPath}`
                                  : ""
                              }${
                                artifact.outputDir
                                  ? ` output:${artifact.outputDir}`
                                  : ""
                              }`,
                          )
                          .join(" | ")}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <AgentInlineButton
                    agentId="feed-open-output"
                    label="Open feed output"
                    group="feed-gen"
                    description="Open the feed generation output directory"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(feedGenerationResult.outputDir),
                      );
                    }}
                  >
                    Open feed output
                  </AgentInlineButton>
                  {feedGenerationResult.artifacts[0]?.manifestPath ? (
                    <AgentInlineButton
                      agentId="feed-open-manifest"
                      label="Open feed manifest"
                      group="feed-gen"
                      description="Open the feed generation manifest"
                      className={FINE_TUNING_ACTION_CLASS}
                      onClick={() => {
                        void openExternalUrl(
                          localViewerUrl(
                            feedGenerationResult.artifacts[0].manifestPath,
                          ),
                        );
                      }}
                    >
                      Open feed manifest
                    </AgentInlineButton>
                  ) : null}
                  {feedGenerationResult.artifacts[0]?.exportPath ? (
                    <AgentInlineButton
                      agentId="feed-open-export"
                      label="Open feed export"
                      group="feed-gen"
                      description="Open the feed generation export"
                      className={FINE_TUNING_ACTION_CLASS}
                      onClick={() => {
                        const exportPath =
                          feedGenerationResult.artifacts[0]?.exportPath;
                        if (!exportPath) return;
                        void openExternalUrl(localViewerUrl(exportPath));
                      }}
                    >
                      Open feed export
                    </AgentInlineButton>
                  ) : null}
                </div>
              </>
            )}
          </div>
          <div className={`${FINE_TUNING_PANEL_CLASS} mt-4 p-3 text-sm`}>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Scenario")}
                  </span>
                  <AgentTextField
                    agentId="scenario-filter"
                    label="Scenario filter"
                    group="scenarios"
                    description="Filter expression to select scenarios to run"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={scenarioFilter}
                    onChange={setScenarioFilter}
                    placeholder="deterministic-pr-smoke"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted sm:col-span-2">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Output")}
                  </span>
                  <AgentTextField
                    agentId="scenario-output-dir"
                    label="Scenario output directory"
                    group="scenarios"
                    description="Output directory for scenario results"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={scenarioOutputDir}
                    onChange={setScenarioOutputDir}
                    placeholder="default"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <AgentCheckboxField
                    agentId="scenario-export-native"
                    label="Export native trajectories"
                    group="scenarios"
                    description="Export native trajectories from scenario runs"
                    checked={scenarioExportNative}
                    onChange={setScenarioExportNative}
                  />
                  {t("finetuningview.ExportNative")}
                </div>
                <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <AgentCheckboxField
                    agentId="scenario-deterministic-proxy"
                    label="Deterministic proxy"
                    group="scenarios"
                    description="Use a deterministic proxy for scenario runs"
                    checked={scenarioDeterministicProxy}
                    onChange={setScenarioDeterministicProxy}
                  />
                  {t("finetuningview.Proxy")}
                </div>
                <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <AgentCheckboxField
                    agentId="scenario-dry-run"
                    label="Scenario dry run"
                    group="scenarios"
                    description="Run the scenario suite as a dry run"
                    checked={scenarioDryRun}
                    onChange={setScenarioDryRun}
                  />
                  {t("finetuningview.DryRun")}
                </div>
                <TrainingActionButton
                  agentId="action-run-scenarios"
                  label={t("finetuningview.RunScenarios")}
                  group="scenarios"
                  description="Run the configured scenario suite and export native trajectories"
                  disabled={scenarioRunning}
                  onClick={() => {
                    void handleRunScenarios();
                  }}
                >
                  {scenarioRunning
                    ? t("finetuningview.RunningScenarios")
                    : t("finetuningview.RunScenarios")}
                </TrainingActionButton>
              </div>
            </div>
            {scenarioResult && (
              <>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.ExitCode")}
                    </div>
                    <div className="mt-1 font-mono text-txt">
                      {scenarioResult.exitCode}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Matrix")}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {scenarioResult.matrixPath}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Viewer")}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {scenarioResult.viewerHtmlPath}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.NativeJsonl")}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {scenarioResult.nativeJsonlPath ?? "n/a"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Command")}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {scenarioResult.command.join(" ")}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <AgentInlineButton
                    agentId="scenario-open-viewer"
                    label="Open scenario viewer"
                    group="scenarios"
                    description="Open the scenario results viewer"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(scenarioResult.viewerHtmlPath),
                      );
                    }}
                  >
                    Open scenario viewer
                  </AgentInlineButton>
                  <AgentInlineButton
                    agentId="scenario-open-matrix"
                    label="Open scenario matrix"
                    group="scenarios"
                    description="Open the scenario results matrix"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(scenarioResult.matrixPath),
                      );
                    }}
                  >
                    Open scenario matrix
                  </AgentInlineButton>
                  {scenarioResult.nativeJsonlPath ? (
                    <AgentInlineButton
                      agentId="scenario-open-native-jsonl"
                      label="Open native JSONL"
                      group="scenarios"
                      description="Open the scenario native JSONL export"
                      className={FINE_TUNING_ACTION_CLASS}
                      onClick={() => {
                        if (scenarioResult.nativeJsonlPath) {
                          void openExternalUrl(
                            localViewerUrl(scenarioResult.nativeJsonlPath),
                          );
                        }
                      }}
                    >
                      Open native JSONL
                    </AgentInlineButton>
                  ) : null}
                  <AgentInlineButton
                    agentId="scenario-open-output"
                    label="Open scenario output"
                    group="scenarios"
                    description="Open the scenario output directory"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(scenarioResult.outputDir),
                      );
                    }}
                  >
                    Open scenario output
                  </AgentInlineButton>
                </div>
              </>
            )}
          </div>
          <div className={`${FINE_TUNING_PANEL_CLASS} mt-4 p-3 text-sm`}>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                <div className="space-y-1 text-xs text-muted md:col-span-2">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Manifest")}
                  </span>
                  <AgentTextField
                    agentId="eval-manifest-path"
                    label="Eval manifest path"
                    group="eval-comparison"
                    description="Training manifest path for the eval comparison"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={evalComparisonManifestPath}
                    onChange={setEvalComparisonManifestPath}
                    placeholder="training manifest path"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.BaseModel")}
                  </span>
                  <AgentTextField
                    agentId="eval-base-model"
                    label="Eval base model"
                    group="eval-comparison"
                    description="Base model id for the eval comparison"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={evalComparisonBaseModel}
                    onChange={setEvalComparisonBaseModel}
                    placeholder="eliza-1-2b-base"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.TrainedModel")}
                  </span>
                  <AgentTextField
                    agentId="eval-trained-model"
                    label="Eval trained model"
                    group="eval-comparison"
                    description="Trained model path for the eval comparison"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={evalComparisonTrainedModelPath}
                    onChange={setEvalComparisonTrainedModelPath}
                    placeholder="eliza-1-2b-trained"
                  />
                </div>
                <div className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Backend")}
                  </span>
                  <AgentNativeSelect
                    agentId="eval-backend"
                    label="Eval backend"
                    group="eval-comparison"
                    description="Compute backend for the eval comparison"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={evalComparisonBackend}
                    onChange={(value) =>
                      setEvalComparisonBackend(value as "cpu" | "mlx" | "cuda")
                    }
                    options={["cpu", "mlx", "cuda"]}
                  >
                    <option value="cpu">cpu</option>
                    <option value="mlx">mlx</option>
                    <option value="cuda">cuda</option>
                  </AgentNativeSelect>
                </div>
                <div className="space-y-1 text-xs text-muted md:col-span-2 xl:col-span-5">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Output")}
                  </span>
                  <AgentTextField
                    agentId="eval-output-dir"
                    label="Eval output directory"
                    group="eval-comparison"
                    description="Output directory for the eval comparison"
                    className={AGENT_FIELD_INPUT_CLASS}
                    value={evalComparisonOutputDir}
                    onChange={setEvalComparisonOutputDir}
                    placeholder="default"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <AgentCheckboxField
                    agentId="eval-include-in-collection"
                    label="Include eval in collection"
                    group="eval-comparison"
                    description="Include the eval comparison in the collection run"
                    checked={evalComparisonEnabled}
                    onChange={setEvalComparisonEnabled}
                  />
                  {t("finetuningview.IncludeInCollection")}
                </div>
                <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <AgentCheckboxField
                    agentId="eval-dry-run"
                    label="Eval comparison dry run"
                    group="eval-comparison"
                    description="Run the eval comparison as a dry run"
                    checked={evalComparisonDryRun}
                    onChange={setEvalComparisonDryRun}
                  />
                  {t("finetuningview.DryRun")}
                </div>
                <TrainingActionButton
                  agentId="action-run-eval-comparison"
                  label={t("finetuningview.RunEvalComparison")}
                  group="eval-comparison"
                  description="Run a local eval comparison between the base and trained models"
                  disabled={evalComparisonRunning}
                  onClick={() => {
                    void handleRunEvalComparison();
                  }}
                >
                  {evalComparisonRunning
                    ? t("finetuningview.Evaluating")
                    : t("finetuningview.RunEvalComparison")}
                </TrainingActionButton>
              </div>
            </div>
            {evalComparisonResult && (
              <>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.ExitCode")}
                    </div>
                    <div className="mt-1 font-mono text-txt">
                      {evalComparisonResult.exitCode}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Artifact")}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {evalComparisonResult.artifactPath}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Report")}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {evalComparisonResult.reportPath}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                      {t("finetuningview.Command")}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {evalComparisonResult.command.join(" ")}
                    </div>
                  </div>
                  {formatEvalComparisonSummary(evalComparisonResult) ? (
                    <div className="md:col-span-2 xl:col-span-4">
                      <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                        Eval metrics
                      </div>
                      <div className="mt-1 break-all font-mono text-xs text-txt">
                        {formatEvalComparisonSummary(evalComparisonResult)}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <AgentInlineButton
                    agentId="eval-open-artifact"
                    label="Open eval artifact"
                    group="eval-comparison"
                    description="Open the eval comparison artifact"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(evalComparisonResult.artifactPath),
                      );
                    }}
                  >
                    Open eval artifact
                  </AgentInlineButton>
                  <AgentInlineButton
                    agentId="eval-open-report"
                    label="Open eval report"
                    group="eval-comparison"
                    description="Open the eval comparison report"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(evalComparisonResult.reportPath),
                      );
                    }}
                  >
                    Open eval report
                  </AgentInlineButton>
                  <AgentInlineButton
                    agentId="eval-open-output"
                    label="Open eval output"
                    group="eval-comparison"
                    description="Open the eval comparison output directory"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(evalComparisonResult.outputDir),
                      );
                    }}
                  >
                    Open eval output
                  </AgentInlineButton>
                </div>
              </>
            )}
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Tiers")}
                </span>
                <AgentTextField
                  agentId="benchmark-tiers"
                  label="Benchmark tiers"
                  group="benchmark"
                  description="Comma-separated benchmark tiers to run"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={benchmarkTiers}
                  onChange={setBenchmarkTiers}
                  placeholder={ELIZA_ONE_BENCHMARK_TIER_LIST}
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Benchmark")}
                </span>
                <AgentNativeSelect
                  agentId="benchmark-kind"
                  label="Benchmark kind"
                  group="benchmark"
                  description="Which benchmark suite to run"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={benchmarkKind}
                  onChange={(value) =>
                    setBenchmarkKind(
                      value as
                        | "eliza_harness_action_selection"
                        | "hermes"
                        | "clawbench"
                        | "all",
                    )
                  }
                  options={[
                    "eliza_harness_action_selection",
                    "hermes",
                    "clawbench",
                    "all",
                  ]}
                >
                  <option value="eliza_harness_action_selection">
                    eliza_harness_action_selection
                  </option>
                  <option value="hermes">hermes</option>
                  <option value="clawbench">clawbench</option>
                  <option value="all">all</option>
                </AgentNativeSelect>
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Variants")}
                </span>
                <AgentNativeSelect
                  agentId="benchmark-variants"
                  label="Benchmark variants"
                  group="benchmark"
                  description="Which model variants to benchmark"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={benchmarkVariants}
                  onChange={(value) =>
                    setBenchmarkVariants(value as "trained" | "base" | "both")
                  }
                  options={["both", "base", "trained"]}
                >
                  <option value="both">both</option>
                  <option value="base">base</option>
                  <option value="trained">trained</option>
                </AgentNativeSelect>
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.MaxSamples")}
                </span>
                <AgentTextField
                  agentId="benchmark-max-samples"
                  label="Benchmark max samples"
                  group="benchmark"
                  description="Maximum samples per benchmark run"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={benchmarkMaxSamples}
                  onChange={setBenchmarkMaxSamples}
                  type="number"
                  placeholder="50"
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.ResultsDb")}
                </span>
                <AgentTextField
                  agentId="benchmark-results-db"
                  label="Benchmark results DB"
                  group="benchmark"
                  description="Path to the benchmark results database"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={benchmarkResultsDb}
                  onChange={setBenchmarkResultsDb}
                  placeholder="default"
                />
              </div>
              <div className="space-y-1 text-xs text-muted sm:col-span-2 xl:col-span-2">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.TrainedModelPath")}
                </span>
                <AgentTextField
                  agentId="benchmark-trained-model-path"
                  label="Benchmark trained model path"
                  group="benchmark"
                  description="Path to the trained model for benchmarking"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={benchmarkTrainedModelPath}
                  onChange={setBenchmarkTrainedModelPath}
                  placeholder="packages/training/checkpoints/eliza-1-2b/final"
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.MatrixOutput")}
                </span>
                <AgentTextField
                  agentId="benchmark-matrix-output"
                  label="Benchmark matrix output"
                  group="benchmark"
                  description="Output directory for the benchmark matrix"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={benchmarkMatrixOutputDir}
                  onChange={setBenchmarkMatrixOutputDir}
                  placeholder="default"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <AgentCheckboxField
                  agentId="benchmark-dry-run"
                  label="Benchmark dry run"
                  group="benchmark"
                  description="Run the benchmark suite as a dry run"
                  checked={benchmarkDryRun}
                  onChange={setBenchmarkDryRun}
                />
                {t("finetuningview.DryRun")}
              </div>
              <TrainingActionButton
                agentId="action-run-benchmark-vs-cerebras"
                label={t("finetuningview.RunBenchmarkVsCerebras")}
                group="benchmark"
                description="Run the benchmark-vs-Cerebras suite for the configured tiers and variants"
                disabled={benchmarkRunning}
                onClick={() => {
                  void handleRunBenchmarkVsCerebras();
                }}
              >
                {benchmarkRunning
                  ? t("finetuningview.RunningBenchmark")
                  : t("finetuningview.RunBenchmarkVsCerebras")}
              </TrainingActionButton>
            </div>
          </div>
          {benchmarkResult && (
            <div className={`${FINE_TUNING_PANEL_CLASS} mt-3 p-3 text-sm`}>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.ExitCode")}
                  </div>
                  <div className="mt-1 font-mono text-txt">
                    {benchmarkResult.exitCode}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.ResultsDb")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {benchmarkResult.resultsDb ?? t("finetuningview.None")}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.MatrixOutput")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {benchmarkResult.matrixOutputDir ??
                      t("finetuningview.None")}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.MatrixArtifact")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {benchmarkResult.matrixArtifactPath ??
                      t("finetuningview.None")}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Output")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {benchmarkResult.outputDir}
                  </div>
                </div>
              </div>
              <div className="mt-3">
                <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                  {t("finetuningview.Command")}
                </div>
                <div className="mt-1 break-all font-mono text-xs text-txt">
                  {benchmarkResult.command.join(" ")}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {benchmarkResult.matrixArtifactPath ? (
                  <AgentInlineButton
                    agentId="benchmark-open-matrix-artifact"
                    label="Open matrix artifact"
                    group="benchmark"
                    description="Open the benchmark matrix artifact"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      if (benchmarkResult.matrixArtifactPath) {
                        void openExternalUrl(
                          localViewerUrl(benchmarkResult.matrixArtifactPath),
                        );
                      }
                    }}
                  >
                    Open matrix artifact
                  </AgentInlineButton>
                ) : null}
                {benchmarkResult.outputDir ? (
                  <AgentInlineButton
                    agentId="benchmark-open-output"
                    label="Open benchmark output"
                    group="benchmark"
                    description="Open the benchmark output directory"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(benchmarkResult.outputDir),
                      );
                    }}
                  >
                    Open benchmark output
                  </AgentInlineButton>
                ) : null}
              </div>
            </div>
          )}
          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.BundleRepo")}
                </span>
                <AgentTextField
                  agentId="bundle-repo-id"
                  label="Bundle repo"
                  group="bundle-stage"
                  description="HuggingFace repo id for the bundle"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={bundleStageRepoId}
                  onChange={setBundleStageRepoId}
                  placeholder="elizaos/eliza-1"
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.BundleTier")}
                </span>
                <AgentNativeSelect
                  agentId="bundle-tier"
                  label="Bundle tier"
                  group="bundle-stage"
                  description="Model tier to stage"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={bundleStageTier}
                  onChange={setBundleStageTier}
                  options={["2b", "4b", "9b", "27b", "27b-256k"]}
                >
                  <option value="2b">2b</option>
                  <option value="4b">4b</option>
                  <option value="9b">9b</option>
                  <option value="27b">27b</option>
                  <option value="27b-256k">27b-256k</option>
                </AgentNativeSelect>
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.LocalDir")}
                </span>
                <AgentTextField
                  agentId="bundle-local-dir"
                  label="Bundle local directory"
                  group="bundle-stage"
                  description="Local directory to stage the bundle into"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={bundleStageLocalDir}
                  onChange={setBundleStageLocalDir}
                  placeholder="/tmp/eliza-1-bundles"
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.MaxBytes")}
                </span>
                <AgentTextField
                  agentId="bundle-max-bytes"
                  label="Bundle max bytes"
                  group="bundle-stage"
                  description="Maximum bytes to stage for the bundle"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={bundleStageMaxBytes}
                  onChange={setBundleStageMaxBytes}
                  type="number"
                />
              </div>
              <div className="space-y-1 text-xs text-muted sm:col-span-2 xl:col-span-1">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.ManifestOutput")}
                </span>
                <AgentTextField
                  agentId="bundle-output-dir"
                  label="Bundle manifest output"
                  group="bundle-stage"
                  description="Output directory for the bundle manifest"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={bundleStageOutputDir}
                  onChange={setBundleStageOutputDir}
                  placeholder="default"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <AgentCheckboxField
                  agentId="bundle-apply"
                  label="Apply bundle"
                  group="bundle-stage"
                  description="Apply the staged bundle"
                  checked={bundleStageApply}
                  onChange={setBundleStageApply}
                />
                {t("finetuningview.Apply")}
              </div>
              <TrainingActionButton
                agentId="action-stage-eliza1-bundle"
                label={t("finetuningview.StageEliza1Bundle")}
                group="bundle"
                description="Stage the Eliza-1 model bundle for the configured repo and tier"
                disabled={bundleStageRunning}
                onClick={() => {
                  void handleStageEliza1Bundle();
                }}
              >
                {bundleStageRunning
                  ? t("finetuningview.StagingBundle")
                  : t("finetuningview.StageEliza1Bundle")}
              </TrainingActionButton>
            </div>
          </div>
          {bundleStageResult && (
            <div className={`${FINE_TUNING_PANEL_CLASS} mt-3 p-3 text-sm`}>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.ExitCode")}
                  </div>
                  <div className="mt-1 font-mono text-txt">
                    {bundleStageResult.exitCode}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.PlannedBytes")}
                  </div>
                  <div className="mt-1 font-mono text-txt">
                    {String(
                      bundleStageResult.plan?.plannedBytes ??
                        t("finetuningview.None"),
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.FileCount")}
                  </div>
                  <div className="mt-1 font-mono text-txt">
                    {String(
                      bundleStageResult.plan?.fileCount ??
                        t("finetuningview.None"),
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.BundleDir")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {String(
                      bundleStageResult.plan?.bundleDir ??
                        t("finetuningview.None"),
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Manifest")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {bundleStageResult.manifestPath}
                  </div>
                </div>
              </div>
              <div className="mt-3">
                <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                  {t("finetuningview.Command")}
                </div>
                <div className="mt-1 break-all font-mono text-xs text-txt">
                  {bundleStageResult.command.join(" ")}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <AgentInlineButton
                  agentId="bundle-open-manifest"
                  label="Open bundle manifest"
                  group="bundle-stage"
                  description="Open the bundle manifest"
                  className={FINE_TUNING_ACTION_CLASS}
                  onClick={() => {
                    void openExternalUrl(
                      localViewerUrl(bundleStageResult.manifestPath),
                    );
                  }}
                >
                  Open bundle manifest
                </AgentInlineButton>
                <AgentInlineButton
                  agentId="bundle-open-output"
                  label="Open bundle output"
                  group="bundle-stage"
                  description="Open the bundle output directory"
                  className={FINE_TUNING_ACTION_CLASS}
                  onClick={() => {
                    void openExternalUrl(
                      localViewerUrl(bundleStageResult.outputDir),
                    );
                  }}
                >
                  Open bundle output
                </AgentInlineButton>
                {bundleStageResult.plan?.bundleDir ? (
                  <AgentInlineButton
                    agentId="bundle-open-dir"
                    label="Open bundle directory"
                    group="bundle-stage"
                    description="Open the staged bundle directory"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      const bundleDir =
                        typeof bundleStageResult.plan?.bundleDir === "string"
                          ? bundleStageResult.plan.bundleDir
                          : null;
                      if (!bundleDir) return;
                      void openExternalUrl(localViewerUrl(bundleDir));
                    }}
                  >
                    Open bundle dir
                  </AgentInlineButton>
                ) : null}
              </div>
            </div>
          )}
          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.ActionBenchmarkFilter")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-filter"
                  label="Action benchmark filter"
                  group="action-benchmark"
                  description="Case id filter for the action benchmark"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkFilter}
                  onChange={setActionBenchmarkFilter}
                  placeholder="case-id[,case-id]"
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.RunsPerCase")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-runs-per-case"
                  label="Action benchmark runs per case"
                  group="action-benchmark"
                  description="Number of runs per benchmark case"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkRunsPerCase}
                  onChange={setActionBenchmarkRunsPerCase}
                  type="number"
                />
              </div>
              <div className="space-y-1 text-xs text-muted sm:col-span-2">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Output")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-output-dir"
                  label="Action benchmark output directory"
                  group="action-benchmark"
                  description="Output directory for the action benchmark"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkOutputDir}
                  onChange={setActionBenchmarkOutputDir}
                  placeholder="default"
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Model")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-model-id"
                  label="Action benchmark model"
                  group="action-benchmark"
                  description="Model id for the action benchmark"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkModelId}
                  onChange={setActionBenchmarkModelId}
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.BaseModel")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-base-model-id"
                  label="Action benchmark base model"
                  group="action-benchmark"
                  description="Base model id for the action benchmark"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkBaseModelId}
                  onChange={setActionBenchmarkBaseModelId}
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.CollectionTiers")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-pair-tiers"
                  label="Action benchmark collection tiers"
                  group="action-benchmark"
                  description="Collection tiers for the paired action benchmark"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkPairTiers}
                  onChange={setActionBenchmarkPairTiers}
                  placeholder={`${ELIZA_ONE_BENCHMARK_TIER_LIST} or all`}
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.RuntimeModel")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-runtime-model"
                  label="Action benchmark runtime model"
                  group="action-benchmark"
                  description="Runtime model for the action benchmark"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkRuntimeModel}
                  onChange={setActionBenchmarkRuntimeModel}
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.BaseRuntimeModel")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-base-runtime-model"
                  label="Action benchmark base runtime model"
                  group="action-benchmark"
                  description="Base runtime model for the action benchmark"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkBaseRuntimeModel}
                  onChange={setActionBenchmarkBaseRuntimeModel}
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Provider")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-provider"
                  label="Action benchmark provider"
                  group="action-benchmark"
                  description="Provider for the action benchmark"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkProvider}
                  onChange={setActionBenchmarkProvider}
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.BaseUrl")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-base-url"
                  label="Action benchmark base URL"
                  group="action-benchmark"
                  description="Base URL for the action benchmark provider"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkBaseUrl}
                  onChange={setActionBenchmarkBaseUrl}
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Variant")}
                </span>
                <AgentNativeSelect
                  agentId="action-benchmark-variant"
                  label="Action benchmark variant"
                  group="action-benchmark"
                  description="Model variant for the action benchmark"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkVariant}
                  onChange={(value) =>
                    setActionBenchmarkVariant(
                      value as "reference" | "base" | "trained",
                    )
                  }
                  options={["trained", "base", "reference"]}
                >
                  <option value="trained">trained</option>
                  <option value="base">base</option>
                  <option value="reference">reference</option>
                </AgentNativeSelect>
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Tier")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-tier"
                  label="Action benchmark tier"
                  group="action-benchmark"
                  description="Tier for the action benchmark"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkTier}
                  onChange={setActionBenchmarkTier}
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Benchmark")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-matrix-benchmark"
                  label="Action benchmark name"
                  group="action-benchmark"
                  description="Benchmark name for the action benchmark matrix"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkMatrixBenchmark}
                  onChange={setActionBenchmarkMatrixBenchmark}
                />
              </div>
              <div className="space-y-1 text-xs text-muted sm:col-span-2">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.DatasetVersion")}
                </span>
                <AgentTextField
                  agentId="action-benchmark-dataset-version"
                  label="Action benchmark dataset version"
                  group="action-benchmark"
                  description="Dataset version for the action benchmark"
                  className={AGENT_FIELD_INPUT_CLASS}
                  value={actionBenchmarkDatasetVersion}
                  onChange={setActionBenchmarkDatasetVersion}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <AgentCheckboxField
                  agentId="action-benchmark-pair-enabled"
                  label="Pair base and trained"
                  group="action-benchmark"
                  description="Pair base and trained variants in the action benchmark"
                  checked={actionBenchmarkPairEnabled}
                  onChange={setActionBenchmarkPairEnabled}
                />
                {t("finetuningview.PairBaseTrained")}
              </div>
              <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <AgentCheckboxField
                  agentId="action-benchmark-use-mocks"
                  label="Use mocks"
                  group="action-benchmark"
                  description="Use mocked responses in the action benchmark"
                  checked={actionBenchmarkUseMocks}
                  onChange={setActionBenchmarkUseMocks}
                />
                {t("finetuningview.UseMocks")}
              </div>
              <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <AgentCheckboxField
                  agentId="action-benchmark-capture"
                  label="Capture trajectories"
                  group="action-benchmark"
                  description="Capture trajectories during the action benchmark"
                  checked={actionBenchmarkCapture}
                  onChange={setActionBenchmarkCapture}
                />
                {t("finetuningview.CaptureTrajectories")}
              </div>
              <div className="flex h-10 items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <AgentCheckboxField
                  agentId="action-benchmark-dry-run"
                  label="Action benchmark dry run"
                  group="action-benchmark"
                  description="Run the action benchmark as a dry run"
                  checked={actionBenchmarkDryRun}
                  onChange={setActionBenchmarkDryRun}
                />
                {t("finetuningview.DryRun")}
              </div>
              <TrainingActionButton
                agentId="action-run-action-benchmark"
                label={t("finetuningview.RunActionBenchmark")}
                group="action-benchmark"
                description="Run the action-selection benchmark for the configured model and tier"
                disabled={actionBenchmarkRunning}
                onClick={() => {
                  void handleRunActionBenchmark();
                }}
              >
                {actionBenchmarkRunning
                  ? t("finetuningview.RunningBenchmark")
                  : t("finetuningview.RunActionBenchmark")}
              </TrainingActionButton>
            </div>
          </div>
          {actionBenchmarkResult && (
            <div className={`${FINE_TUNING_PANEL_CLASS} mt-3 p-3 text-sm`}>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.ExitCode")}
                  </div>
                  <div className="mt-1 font-mono text-txt">
                    {actionBenchmarkResult.exitCode}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Report")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {actionBenchmarkResult.reportJsonPath}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Trajectories")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {actionBenchmarkResult.trajectoryDir}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    {t("finetuningview.Output")}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {actionBenchmarkResult.outputDir}
                  </div>
                </div>
              </div>
              <div className="mt-3">
                <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                  {t("finetuningview.Command")}
                </div>
                <div className="mt-1 break-all font-mono text-xs text-txt">
                  {actionBenchmarkResult.command.join(" ")}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <AgentInlineButton
                  agentId="action-benchmark-open-report"
                  label="Open action report"
                  group="action-benchmark"
                  description="Open the action benchmark report"
                  className={FINE_TUNING_ACTION_CLASS}
                  onClick={() => {
                    void openExternalUrl(
                      localViewerUrl(actionBenchmarkResult.reportJsonPath),
                    );
                  }}
                >
                  Open action report
                </AgentInlineButton>
                <AgentInlineButton
                  agentId="action-benchmark-open-summary"
                  label="Open action summary"
                  group="action-benchmark"
                  description="Open the action benchmark summary"
                  className={FINE_TUNING_ACTION_CLASS}
                  onClick={() => {
                    void openExternalUrl(
                      localViewerUrl(actionBenchmarkResult.reportMarkdownPath),
                    );
                  }}
                >
                  Open action summary
                </AgentInlineButton>
                <AgentInlineButton
                  agentId="action-benchmark-open-trajectories"
                  label="Open action trajectories"
                  group="action-benchmark"
                  description="Open the action benchmark trajectories directory"
                  className={FINE_TUNING_ACTION_CLASS}
                  onClick={() => {
                    void openExternalUrl(
                      localViewerUrl(actionBenchmarkResult.trajectoryDir),
                    );
                  }}
                >
                  Open action trajectories
                </AgentInlineButton>
                <AgentInlineButton
                  agentId="action-benchmark-open-output"
                  label="Open action output"
                  group="action-benchmark"
                  description="Open the action benchmark output directory"
                  className={FINE_TUNING_ACTION_CLASS}
                  onClick={() => {
                    void openExternalUrl(
                      localViewerUrl(actionBenchmarkResult.outputDir),
                    );
                  }}
                >
                  Open action output
                </AgentInlineButton>
              </div>
            </div>
          )}
        </section>

        <DatasetSection
          buildLimit={buildLimit}
          setBuildLimit={setBuildLimit}
          buildMinCalls={buildMinCalls}
          setBuildMinCalls={setBuildMinCalls}
          datasetBuilding={datasetBuilding}
          onBuildDataset={onBuildDataset}
          onRefreshDatasets={onRefreshDatasets}
          datasets={datasets}
          selectedDatasetId={selectedDatasetId}
          setSelectedDatasetId={setSelectedDatasetId}
          t={t}
        />

        <TrainingJobsSection
          selectedDatasetId={selectedDatasetId}
          setSelectedDatasetId={setSelectedDatasetId}
          datasets={datasets}
          startBackend={startBackend}
          setStartBackend={setStartBackend}
          startModel={startModel}
          setStartModel={setStartModel}
          startIterations={startIterations}
          setStartIterations={setStartIterations}
          startBatchSize={startBatchSize}
          setStartBatchSize={setStartBatchSize}
          startLearningRate={startLearningRate}
          setStartLearningRate={setStartLearningRate}
          startingJob={startingJob}
          activeRunningJob={activeRunningJob}
          onStartJob={onStartJob}
          onRefreshJobs={onRefreshJobs}
          jobs={jobs}
          selectedJobId={selectedJobId}
          setSelectedJobId={setSelectedJobId}
          cancellingJobId={cancellingJobId}
          onCancelJob={onCancelJob}
          selectedJob={selectedJob}
          t={t}
        />

        <TrainedModelsSection
          models={models}
          selectedModelId={selectedModelId}
          setSelectedModelId={setSelectedModelId}
          selectedModel={selectedModel}
          importModelName={importModelName}
          setImportModelName={setImportModelName}
          importBaseModel={importBaseModel}
          setImportBaseModel={setImportBaseModel}
          importOllamaUrl={importOllamaUrl}
          setImportOllamaUrl={setImportOllamaUrl}
          activateProviderModel={activateProviderModel}
          setActivateProviderModel={setActivateProviderModel}
          modelAction={modelAction}
          smokeResult={smokeResult}
          onImport={onImportModel}
          onActivate={onActivateModel}
          onBenchmark={onBenchmarkModel}
          onSmokeTest={onSmokeTestModel}
          t={t}
        />

        <LiveEventsPanel events={trainingEvents} t={t} />
      </div>
    </ContentLayout>
  );
}

function formatDashboardNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "0";
}

function FineTuningDetailMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 p-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-foreground">
        {value}
      </div>
    </div>
  );
}

export function FineTuningDetailExtension({ app }: AppDetailExtensionProps) {
  const [history, setHistory] =
    useState<ListTrainingCollectionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [runningGapId, setRunningGapId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refreshCollections = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      setHistory(await client.listTrainingCollections({ limit: 3 }));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCollections();
  }, [refreshCollections]);

  const runGapRecommendation = useCallback(
    async (
      gap: NonNullable<
        ListTrainingCollectionsResponse["collections"][number]["readinessGaps"]
      >[number],
    ) => {
      if (!gap.recommendedCapability) return;
      setRunningGapId(gap.id);
      setErrorMessage(null);
      try {
        await interact(gap.recommendedCapability, gap.recommendedParams ?? {});
        await refreshCollections();
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setRunningGapId(null);
      }
    },
    [refreshCollections],
  );

  const latest = history?.collections[0] ?? null;
  const coverage = latest?.coverage;
  const dataSources = latest
    ? Object.values(latest.dataSources).reduce((sum, count) => sum + count, 0)
    : 0;
  const readableSamples = coverage?.readableSamples.total ?? 0;
  const scoredComparisons =
    coverage?.benchmarks.scoredComparisons ??
    latest?.benchmarks.benchmarkComparisons ??
    0;
  const modelCount =
    coverage?.models.inventoryCount ?? coverage?.models.artifacts ?? 0;
  const baseline = latest?.benchmarks.baselineProgress;
  const topGaps = latest?.readinessGaps.slice(0, 3) ?? [];

  return (
    <div
      data-testid="fine-tuning-detail-extension"
      className="flex flex-col gap-3 px-1 py-2"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
            {app.displayName ?? "Fine Tuning"}
          </div>
          <h3 className="mt-1 truncate text-sm font-semibold text-foreground">
            {latest ? "Latest training collection" : "Training collection"}
          </h3>
          <p className="mt-1 text-xs text-muted">
            {latest
              ? `${latest.readinessStatus} readiness, ${latest.artifactCount} artifacts`
              : "None"}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refreshCollections()}
          disabled={loading}
        >
          {loading ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {errorMessage ? (
        <div className="rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {errorMessage}
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <FineTuningDetailMetric
          label="Data sources"
          value={formatDashboardNumber(dataSources)}
        />
        <FineTuningDetailMetric
          label="Readable samples"
          value={formatDashboardNumber(readableSamples)}
        />
        <FineTuningDetailMetric
          label="Scored evals"
          value={formatDashboardNumber(scoredComparisons)}
        />
        <FineTuningDetailMetric
          label="Models"
          value={formatDashboardNumber(modelCount)}
        />
      </div>

      {latest ? (
        <div className="flex flex-col gap-2 p-3 text-xs text-muted">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <span className="text-muted">Generated </span>
              <span className="text-foreground">{latest.generatedAt}</span>
            </div>
            <div className="min-w-0">
              <span className="text-muted">Tiers </span>
              <span className="text-foreground">
                {latest.benchmarks.tiers.length
                  ? latest.benchmarks.tiers.join(", ")
                  : "none"}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-muted">Readiness </span>
              <span className="text-foreground">
                {latest.readiness.ready} ready / {latest.readiness.partial}{" "}
                partial / {latest.readiness.missing} missing
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-muted">Steps </span>
              <span className="text-foreground">
                {Object.entries(latest.stepCounts)
                  .map(([status, count]) => `${status}:${count}`)
                  .join(" ")}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-muted">Baseline </span>
              <span className="text-foreground">
                established{" "}
                {baseline?.establishedTiers.length
                  ? baseline.establishedTiers.join(", ")
                  : "none"}{" "}
                / next {baseline?.nextTier ?? "none"}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-muted">Remaining </span>
              <span className="text-foreground">
                {baseline?.remainingTiers.length
                  ? baseline.remainingTiers.join(", ")
                  : "none"}
              </span>
            </div>
          </div>
          {topGaps.length > 0 ? (
            <div className="flex flex-col gap-1 p-2">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
                Next gaps
              </div>
              {topGaps.map((gap) => (
                <div
                  key={gap.id}
                  className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-foreground">
                      {gap.id}:{gap.status}
                    </div>
                    <div className="line-clamp-2 text-xs text-muted">
                      {gap.note}
                    </div>
                  </div>
                  {gap.recommendedCapability ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void runGapRecommendation(gap)}
                      disabled={runningGapId === gap.id}
                      title={gap.recommendedCapability}
                    >
                      {runningGapId === gap.id ? "Running" : "Run"}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void openExternalUrl(
                  localViewerUrl(latest.analysisIndexHtmlPath),
                )
              }
            >
              Open analysis
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void openExternalUrl(localViewerUrl(latest.readmePath))
              }
            >
              Open README
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void openExternalUrl(localViewerUrl(latest.manifestPath))
              }
            >
              Open manifest
            </Button>
            {history?.indexHtmlPath ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void openExternalUrl(localViewerUrl(history.indexHtmlPath))
                }
              >
                Open run index
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

registerDetailExtension(FINE_TUNING_DETAIL_PANEL_ID, FineTuningDetailExtension);
