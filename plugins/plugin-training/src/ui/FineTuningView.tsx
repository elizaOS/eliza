import { Button, ContentLayout, client, confirmDesktopAction, openExternalUrl, parsePositiveFloat, parsePositiveInteger, registerDetailExtension, type AppDetailExtensionProps, type HuggingFaceDatasetIngestResponse, type ListTrainingCollectionsResponse, type RunActionBenchmarkResponse, type RunBenchmarkVsCerebrasResponse, type RunFeedGenerationResponse, type RunLocalEvalComparisonResponse, type RunScenarioResponse, type StageEliza1BundleResponse, type TrainingCollectionPreflightSummary, type RunTrainingCollectionResponse, type StartTrainingOptions, type StreamEventEnvelope, type TrainingAnalysisIndexResponse, type TrainingDatasetRecord, type TrainingJobRecord, type TrainingModelRecord, type TrainingReadinessReportResponse, type TrainingStatus, type TrainingStreamEvent, type TrainingTrajectoryDetail, type TrainingTrajectoryList, useApp, useIntervalWhenDocumentVisible } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ELIZA_ONE_BENCHMARK_TIERS,
  ELIZA_ONE_BENCHMARK_TIER_LIST,
  elizaOneActionBenchmarkPairs,
  parseElizaOneBenchmarkTiers,
} from "../core/eliza1-benchmark-recipe.js";
import {
  asTrainingEvent,
  DatasetSection,
  FINE_TUNING_ACTION_CLASS,
  FINE_TUNING_PANEL_CLASS,
  FINE_TUNING_SECTION_CLASS,
  FINE_TUNING_SECTION_HEADER_CLASS,
  FINE_TUNING_SECTION_KICKER_CLASS,
  FINE_TUNING_STATUS_CARD_CLASS,
  LiveEventsPanel,
  TrainedModelsSection,
  TrainingJobsSection,
  TrajectoriesSection,
} from "./fine-tuning-panels.js";

const FINE_TUNING_DETAIL_PANEL_ID = "plugin-dash-fine-tuning";

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

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function parseCollectionTierList(value: string): string[] {
  return parseElizaOneBenchmarkTiers(value, []);
}

function localViewerUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  return encodeURI(`file://${path}`);
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
  const base = modelInventory.filter((model) => model.variant === "base").length;
  const trained = modelInventory.filter(
    (model) => model.variant === "trained",
  ).length;
  const parts = [];
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
      stringSummaryValue(source) ??
      stringSummaryValue(recordValue(source).kind)
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

export function FineTuningView({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  const { handleRestart, setActionNotice, t } = useApp();

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
    useState("eliza-1-0_8b-base");
  const [evalComparisonTrainedModelPath, setEvalComparisonTrainedModelPath] =
    useState("eliza-1-0_8b-trained");
  const [evalComparisonBackend, setEvalComparisonBackend] = useState<
    "cpu" | "mlx" | "cuda"
  >("cpu");
  const [evalComparisonOutputDir, setEvalComparisonOutputDir] = useState("");
  const [evalComparisonDryRun, setEvalComparisonDryRun] = useState(true);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkResult, setBenchmarkResult] =
    useState<RunBenchmarkVsCerebrasResponse | null>(null);
  const [benchmarkTiers, setBenchmarkTiers] = useState("0_8b");
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
  const [bundleStageTier, setBundleStageTier] = useState("0_8b");
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
  const [actionBenchmarkModelId, setActionBenchmarkModelId] = useState(
    "eliza-1-0_8b-trained",
  );
  const [actionBenchmarkRuntimeModel, setActionBenchmarkRuntimeModel] =
    useState("eliza-1-0_8b-trained");
  const [actionBenchmarkPairEnabled, setActionBenchmarkPairEnabled] =
    useState(true);
  const [actionBenchmarkPairTiers, setActionBenchmarkPairTiers] =
    useState("0_8b");
  const [actionBenchmarkBaseModelId, setActionBenchmarkBaseModelId] =
    useState("eliza-1-0_8b-base");
  const [actionBenchmarkBaseRuntimeModel, setActionBenchmarkBaseRuntimeModel] =
    useState("eliza-1-0_8b-base");
  const [actionBenchmarkProvider, setActionBenchmarkProvider] =
    useState("local-llama-cpp");
  const [actionBenchmarkBaseUrl, setActionBenchmarkBaseUrl] = useState(
    "http://localhost:11434/v1",
  );
  const [actionBenchmarkVariant, setActionBenchmarkVariant] = useState<
    "reference" | "base" | "trained"
  >("trained");
  const [actionBenchmarkTier, setActionBenchmarkTier] = useState("0_8b");
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
    const nextDatasets = asArray(listed.datasets);
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
    const nextJobs = asArray(listed.jobs);
    setJobs(nextJobs);
    setSelectedJobId((prev) => {
      if (prev && nextJobs.some((job) => job.id === prev)) return prev;
      return nextJobs[0]?.id ?? "";
    });
  }, []);

  const loadModels = useCallback(async () => {
    const listed = await client.listTrainingModels();
    const nextModels = asArray(listed.models);
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
    } finally {
      setCollectionHistoryLoading(false);
    }
  }, []);

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

  const handleRunTrainingCollection = useCallback(async (preflightOnly = false) => {
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
                  runtimeModel: actionBenchmarkRuntimeModel.trim() || undefined,
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
      setCollectionPreflightResult(result.manifest.evidence.preflight ?? null);
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
  }, [
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
  ]);

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
    const unbind = client.onWsEvent("training_event", (rawEnvelope) => {
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
    });
    return () => {
      unbind();
    };
  }, [loadDatasets, loadJobs, loadModels, loadStatus]);

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
      <div data-testid="fine-tuning-view" className="space-y-6 pb-8">
        <section className={FINE_TUNING_SECTION_CLASS}>
          <div className={FINE_TUNING_SECTION_HEADER_CLASS}>
            <div className="space-y-2">
              <div className={FINE_TUNING_SECTION_KICKER_CLASS}>
                {t("finetuningview.FineTuning")}
              </div>
              <h2 className="text-xl font-semibold text-txt">
                {t("finetuningview.FineTuning")}
              </h2>
              <p className="max-w-2xl text-sm leading-relaxed text-muted">
                {t("finetuningview.BuildDatasetsFrom")}
              </p>
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
            <div className="mt-3 rounded-xl border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
              {errorMessage}
            </div>
          )}
        </section>

        <section className={FINE_TUNING_SECTION_CLASS}>
          <div className={FINE_TUNING_SECTION_HEADER_CLASS}>
            <div className="space-y-1">
              <div className={FINE_TUNING_SECTION_KICKER_CLASS}>
                {t("finetuningview.Overview")}
              </div>
              <div className="text-lg font-semibold text-txt">
                {t("finetuningview.Status")}
              </div>
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
            <div className="space-y-1">
              <div className={FINE_TUNING_SECTION_KICKER_CLASS}>
                {t("finetuningview.Analysis")}
              </div>
              <div className="text-lg font-semibold text-txt">
                {t("finetuningview.TrainingAnalysisIndex")}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <TrainingActionButton
                agentId="action-collect-and-index"
                label={t("finetuningview.CollectAndIndex")}
                group="analysis"
                description="Run the full training data collection and build the analysis index"
                disabled={collectionRunning}
                onClick={() => {
                  void handleRunTrainingCollection();
                }}
              >
                {collectionRunning
                  ? t("finetuningview.Collecting")
                  : t("finetuningview.CollectAndIndex")}
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
                label={t("finetuningview.BuildAnalysisIndex")}
                group="analysis"
                description="Build the training analysis index from collected artifacts"
                disabled={analysisBuilding}
                onClick={() => {
                  void handleBuildAnalysisIndex();
                }}
              >
                {analysisBuilding
                  ? t("finetuningview.Indexing")
                  : t("finetuningview.BuildAnalysisIndex")}
              </TrainingActionButton>
              <TrainingActionButton
                agentId="action-build-readiness-report"
                label={t("finetuningview.BuildReadinessReport")}
                group="analysis"
                description="Build the training readiness report and surface missing checks"
                disabled={readinessBuilding}
                onClick={() => {
                  void handleBuildReadinessReport();
                }}
              >
                {readinessBuilding
                  ? t("finetuningview.CheckingReadiness")
                  : t("finetuningview.BuildReadinessReport")}
              </TrainingActionButton>
            </div>
          </div>
          <div className={`${FINE_TUNING_PANEL_CLASS} p-3 text-sm`}>
            <div className="mb-3 border-b border-border/50 pb-3">
              <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <input
                  type="checkbox"
                  checked={collectionPreflightProbe}
                  onChange={(event) =>
                    setCollectionPreflightProbe(event.target.checked)
                  }
                />
                Probe live endpoints
              </label>
            </div>
            <div className="mb-3 border-b border-border/50 pb-3">
              <div className="mb-2 text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                Natural trajectory import
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-1 text-xs text-muted md:col-span-2">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    Sanitized JSONL
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={naturalSanitizedJsonlPath}
                    onChange={(event) =>
                      setNaturalSanitizedJsonlPath(event.target.value)
                    }
                    placeholder="/path/to/trajectories.sanitized.jsonl"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted md:col-span-2">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    Raw JSONL
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={naturalRawJsonlPath}
                    onChange={(event) =>
                      setNaturalRawJsonlPath(event.target.value)
                    }
                    placeholder="/path/to/trajectories.raw.jsonl"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    Run ID
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={naturalRunId}
                    onChange={(event) => setNaturalRunId(event.target.value)}
                    placeholder="app-run-1"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    Task buckets
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={naturalTasks}
                    onChange={(event) => setNaturalTasks(event.target.value)}
                    placeholder="response,action_planner"
                  />
                </label>
                <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <input
                    type="checkbox"
                    checked={naturalIncludeRaw}
                    onChange={(event) =>
                      setNaturalIncludeRaw(event.target.checked)
                    }
                  />
                  Include raw
                </label>
              </div>
            </div>
            {readinessReport ? (
              <div className="mb-3 border-b border-border/50 pb-3">
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
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(readinessReport.reportPath),
                      );
                    }}
                  >
                    Open readiness report
                  </Button>
                  {readinessReport.report.analysisIndexHtmlPath ? (
                    <Button
                      variant="outline"
                      size="sm"
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
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(readinessReport.outputDir),
                      );
                    }}
                  >
                    Open readiness output
                  </Button>
                </div>
                {readinessReport.report.checks.some(
                  (check) => check.status !== "ready",
                ) ? (
                  <div className="mt-3 space-y-2">
                    {readinessReport.report.checks
                      .filter((check) => check.status !== "ready")
                      .slice(0, 5)
                      .map((check) => (
                        <div
                          key={check.id}
                          className="grid gap-2 border-t border-border/40 pt-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                        >
                          <div>
                            <div className="font-mono text-xs text-txt">
                              {check.label} · {check.status}
                            </div>
                            <div className="mt-1 text-xs text-muted">
                              {check.note}
                            </div>
                          </div>
                          {check.recommendedAction ? (
                            <div className="flex flex-col items-start gap-2">
                              <div className="break-all font-mono text-xs text-muted">
                                {check.recommendedAction.capability}
                                {Object.keys(check.recommendedAction.params)
                                  .length > 0
                                  ? ` ${JSON.stringify(
                                      check.recommendedAction.params,
                                    )}`
                                  : ""}
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                className={FINE_TUNING_ACTION_CLASS}
                                disabled={readinessActionRunning !== null}
                                onClick={() => {
                                  if (check.recommendedAction) {
                                    void handleRunReadinessRecommendation(
                                      check.id,
                                      check.recommendedAction,
                                    );
                                  }
                                }}
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
                      ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {collectionPreflightResult ? (
              <div className="mb-3 border-b border-border/50 pb-3">
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
              <div className="mb-3 grid gap-3 border-b border-border/50 pb-3 md:grid-cols-2 xl:grid-cols-4">
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
                  <Button
                    variant="outline"
                    size="sm"
                    className={`${FINE_TUNING_ACTION_CLASS} mt-2`}
                    onClick={() =>
                      void openExternalUrl(
                        localViewerUrl(collectionResult.readmePath),
                      )
                    }
                  >
                    Open summary
                  </Button>
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
                  <Button
                    variant="outline"
                    size="sm"
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
                  </Button>
                </div>
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                    Collection index
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-txt">
                    {collectionResult.collectionIndex.indexHtmlPath}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
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
                  </Button>
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
                    {
                      collectionResult.manifest.evidence.evals.evalArtifacts
                    }{" "}
                    matrices:
                    {
                      collectionResult.manifest.evidence.evals.benchmarkMatrices
                    }{" "}
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
                    {
                      collectionResult.manifest.evidence.readinessGaps.find(
                        (gap) => gap.id === "readable_source_samples",
                      )?.status ?? "ready"
                    }
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
                          step.paths.slice(0, 3).map(
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
                Object.values(collectionResult.manifest.evidence.sourceSamples)
                  .flat().length > 0 ? (
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
                              comparison.modelBacked ? "model-backed" : "partial"
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
                    {collectionResult.manifest.evidence.benchmarks.baselineProgress
                      .nextTier ?? "none"}{" "}
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
              <div className="mb-3 border-b border-border/50 pb-3">
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
                    <Button
                      variant="outline"
                      size="sm"
                      className={FINE_TUNING_ACTION_CLASS}
                      disabled={collectionHistoryLoading}
                      onClick={() => {
                        void loadCollectionHistory();
                      }}
                    >
                      {collectionHistoryLoading ? "Refreshing" : "Refresh runs"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className={FINE_TUNING_ACTION_CLASS}
                      onClick={() =>
                        void openExternalUrl(
                          localViewerUrl(collectionHistory.indexHtmlPath),
                        )
                      }
                    >
                      Open collection index
                    </Button>
                  </div>
                </div>
                {collectionHistory.collections.length > 0 ? (
                  <div className="grid gap-2">
                    {collectionHistory.collections.slice(0, 5).map((run) => (
                      <div
                        key={run.manifestPath}
                        className="rounded border border-border/50 p-2"
                      >
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
                                                : "incomplete"
                                        }`,
                                    )
                                    .join(" ")}`
                                : ""}
                              {" "}evals:{run.evals?.evalArtifacts ?? 0} eval-comparisons:
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
                                      .filter((gap) => gap.recommendedCapability)
                                      .slice(0, 4)
                                      .map((gap) => (
                                        <Button
                                          key={`${run.manifestPath}:${gap.id}:${gap.recommendedCapability}`}
                                          variant="outline"
                                          size="sm"
                                          className={FINE_TUNING_ACTION_CLASS}
                                          disabled={
                                            readinessActionRunning ===
                                            `history:${gap.id}`
                                          }
                                          title={`${gap.id}: ${gap.recommendedCapability}`}
                                          onClick={() =>
                                            void handleRunReadinessRecommendation(
                                              `history:${gap.id}`,
                                              {
                                                capability:
                                                  gap.recommendedCapability!,
                                                params:
                                                  gap.recommendedParams ?? {},
                                              },
                                            )
                                          }
                                        >
                                          Run {gap.id}
                                        </Button>
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
                                {run.coverage.dataSources.trainingJsonl} scored-evals:
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
                                        sample.task ?? sample.sourceKind ?? "n/a"
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
                                    <Button
                                      key={`${artifact.category}:${artifact.path}`}
                                      variant="ghost"
                                      size="sm"
                                      className={FINE_TUNING_ACTION_CLASS}
                                      title={[
                                        artifact.schema ?? "source artifact",
                                        artifact.path,
                                      ].join(" · ")}
                                      onClick={() =>
                                        void openExternalUrl(
                                          localViewerUrl(artifact.path),
                                        )
                                      }
                                    >
                                      {artifact.category}:{artifact.title}
                                    </Button>
                                  ))}
                              </div>
                            ) : null}
                            {run.evidenceArtifacts?.length ? (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {run.evidenceArtifacts
                                  .slice(0, 6)
                                  .map((artifact) => (
                                    <Button
                                      key={`${artifact.category}:${artifact.path}`}
                                      variant="ghost"
                                      size="sm"
                                      className={FINE_TUNING_ACTION_CLASS}
                                      title={[
                                        artifact.schema ?? "evidence artifact",
                                        artifact.path,
                                      ].join(" · ")}
                                      onClick={() =>
                                        void openExternalUrl(
                                          localViewerUrl(artifact.path),
                                        )
                                      }
                                    >
                                      {artifact.category}:{artifact.title}
                                    </Button>
                                  ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className={FINE_TUNING_ACTION_CLASS}
                              onClick={() =>
                                void openExternalUrl(
                                  localViewerUrl(run.analysisIndexHtmlPath),
                                )
                              }
                            >
                              Open saved viewer
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className={FINE_TUNING_ACTION_CLASS}
                              onClick={() =>
                                void openExternalUrl(
                                  localViewerUrl(run.readmePath),
                                )
                              }
                            >
                              Open saved summary
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="font-mono text-xs text-muted">
                    No saved collection runs found.
                  </div>
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
                  <Button
                    variant="outline"
                    size="sm"
                    className={`${FINE_TUNING_ACTION_CLASS} mt-2`}
                    onClick={() =>
                      void openExternalUrl(
                        localViewerUrl(analysisIndex.indexHtmlPath),
                      )
                    }
                  >
                    Open viewer
                  </Button>
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
                              }/${
                                tier.hasImprovement ? "improvement" : "-"
                              }`,
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
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.HuggingFaceRepo")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={hfRepoId}
                    onChange={(event) => setHfRepoId(event.target.value)}
                    placeholder="elizaos/eliza-1-training"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Revision")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={hfRevision}
                    onChange={(event) => setHfRevision(event.target.value)}
                    placeholder="main"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted md:col-span-2">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Output")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={hfOutputDir}
                    onChange={(event) => setHfOutputDir(event.target.value)}
                    placeholder="default"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted md:col-span-2 xl:col-span-4">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Files")}
                  </span>
                  <textarea
                    className="min-h-24 w-full rounded-xl border border-border/60 bg-bg/50 px-3 py-2 font-mono text-xs text-txt outline-none focus:border-accent"
                    value={hfFiles}
                    onChange={(event) => setHfFiles(event.target.value)}
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <input
                    type="checkbox"
                    checked={hfDryRun}
                    onChange={(event) => setHfDryRun(event.target.checked)}
                  />
                  {t("finetuningview.DryRun")}
                </label>
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
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(hfIngestResult.manifestPath),
                      );
                    }}
                  >
                    Open HF manifest
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(hfIngestResult.outputDir),
                      );
                    }}
                  >
                    Open HF output
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className={`${FINE_TUNING_PANEL_CLASS} mt-4 p-3 text-sm`}>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Archetypes")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={feedArchetypes}
                    onChange={(event) => setFeedArchetypes(event.target.value)}
                    placeholder="trader"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Agents")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={feedNumAgents}
                    onChange={(event) => setFeedNumAgents(event.target.value)}
                    inputMode="numeric"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Ticks")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={feedTicks}
                    onChange={(event) => setFeedTicks(event.target.value)}
                    inputMode="numeric"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Parallel")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={feedParallel}
                    onChange={(event) => setFeedParallel(event.target.value)}
                    inputMode="numeric"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Output")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={feedOutputDir}
                    onChange={(event) => setFeedOutputDir(event.target.value)}
                    placeholder="default"
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <input
                    type="checkbox"
                    checked={feedCleanup}
                    onChange={(event) => setFeedCleanup(event.target.checked)}
                  />
                  {t("finetuningview.Cleanup")}
                </label>
                <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <input
                    type="checkbox"
                    checked={feedDryRun}
                    onChange={(event) => setFeedDryRun(event.target.checked)}
                  />
                  {t("finetuningview.DryRun")}
                </label>
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
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(feedGenerationResult.outputDir),
                      );
                    }}
                  >
                    Open feed output
                  </Button>
                  {feedGenerationResult.artifacts[0]?.manifestPath ? (
                    <Button
                      variant="outline"
                      size="sm"
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
                    </Button>
                  ) : null}
                  {feedGenerationResult.artifacts[0]?.exportPath ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className={FINE_TUNING_ACTION_CLASS}
                      onClick={() => {
                        void openExternalUrl(
                          localViewerUrl(
                            feedGenerationResult.artifacts[0].exportPath,
                          ),
                        );
                      }}
                    >
                      Open feed export
                    </Button>
                  ) : null}
                </div>
              </>
            )}
          </div>
          <div className={`${FINE_TUNING_PANEL_CLASS} mt-4 p-3 text-sm`}>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Scenario")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={scenarioFilter}
                    onChange={(event) => setScenarioFilter(event.target.value)}
                    placeholder="deterministic-pr-smoke"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted sm:col-span-2">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Output")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={scenarioOutputDir}
                    onChange={(event) =>
                      setScenarioOutputDir(event.target.value)
                    }
                    placeholder="default"
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <input
                    type="checkbox"
                    checked={scenarioExportNative}
                    onChange={(event) =>
                      setScenarioExportNative(event.target.checked)
                    }
                  />
                  {t("finetuningview.ExportNative")}
                </label>
                <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <input
                    type="checkbox"
                    checked={scenarioDeterministicProxy}
                    onChange={(event) =>
                      setScenarioDeterministicProxy(event.target.checked)
                    }
                  />
                  {t("finetuningview.Proxy")}
                </label>
                <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <input
                    type="checkbox"
                    checked={scenarioDryRun}
                    onChange={(event) =>
                      setScenarioDryRun(event.target.checked)
                    }
                  />
                  {t("finetuningview.DryRun")}
                </label>
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
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(scenarioResult.viewerHtmlPath),
                      );
                    }}
                  >
                    Open scenario viewer
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(scenarioResult.matrixPath),
                      );
                    }}
                  >
                    Open scenario matrix
                  </Button>
                  {scenarioResult.nativeJsonlPath ? (
                    <Button
                      variant="outline"
                      size="sm"
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
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(scenarioResult.outputDir),
                      );
                    }}
                  >
                    Open scenario output
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className={`${FINE_TUNING_PANEL_CLASS} mt-4 p-3 text-sm`}>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                <label className="space-y-1 text-xs text-muted md:col-span-2">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Manifest")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={evalComparisonManifestPath}
                    onChange={(event) =>
                      setEvalComparisonManifestPath(event.target.value)
                    }
                    placeholder="training manifest path"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.BaseModel")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={evalComparisonBaseModel}
                    onChange={(event) =>
                      setEvalComparisonBaseModel(event.target.value)
                    }
                    placeholder="eliza-1-0_8b-base"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.TrainedModel")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={evalComparisonTrainedModelPath}
                    onChange={(event) =>
                      setEvalComparisonTrainedModelPath(event.target.value)
                    }
                    placeholder="eliza-1-0_8b-trained"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Backend")}
                  </span>
                  <select
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={evalComparisonBackend}
                    onChange={(event) =>
                      setEvalComparisonBackend(
                        event.target.value as "cpu" | "mlx" | "cuda",
                      )
                    }
                  >
                    <option value="cpu">cpu</option>
                    <option value="mlx">mlx</option>
                    <option value="cuda">cuda</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs text-muted md:col-span-2 xl:col-span-5">
                  <span className="font-semibold uppercase tracking-[0.14em]">
                    {t("finetuningview.Output")}
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                    value={evalComparisonOutputDir}
                    onChange={(event) =>
                      setEvalComparisonOutputDir(event.target.value)
                    }
                    placeholder="default"
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <input
                    type="checkbox"
                    checked={evalComparisonEnabled}
                    onChange={(event) =>
                      setEvalComparisonEnabled(event.target.checked)
                    }
                  />
                  {t("finetuningview.IncludeInCollection")}
                </label>
                <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                  <input
                    type="checkbox"
                    checked={evalComparisonDryRun}
                    onChange={(event) =>
                      setEvalComparisonDryRun(event.target.checked)
                    }
                  />
                  {t("finetuningview.DryRun")}
                </label>
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
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(evalComparisonResult.artifactPath),
                      );
                    }}
                  >
                    Open eval artifact
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(evalComparisonResult.reportPath),
                      );
                    }}
                  >
                    Open eval report
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(evalComparisonResult.outputDir),
                      );
                    }}
                  >
                    Open eval output
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Tiers")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={benchmarkTiers}
                  onChange={(event) => setBenchmarkTiers(event.target.value)}
                  placeholder={ELIZA_ONE_BENCHMARK_TIER_LIST}
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Benchmark")}
                </span>
                <select
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={benchmarkKind}
                  onChange={(event) =>
                    setBenchmarkKind(
                      event.target.value as
                        | "eliza_harness_action_selection"
                        | "hermes"
                        | "clawbench"
                        | "all",
                    )
                  }
                >
                  <option value="eliza_harness_action_selection">
                    eliza_harness_action_selection
                  </option>
                  <option value="hermes">hermes</option>
                  <option value="clawbench">clawbench</option>
                  <option value="all">all</option>
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Variants")}
                </span>
                <select
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={benchmarkVariants}
                  onChange={(event) =>
                    setBenchmarkVariants(
                      event.target.value as "trained" | "base" | "both",
                    )
                  }
                >
                  <option value="both">both</option>
                  <option value="base">base</option>
                  <option value="trained">trained</option>
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.MaxSamples")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={benchmarkMaxSamples}
                  onChange={(event) =>
                    setBenchmarkMaxSamples(event.target.value)
                  }
                  inputMode="numeric"
                  placeholder="50"
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.ResultsDb")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={benchmarkResultsDb}
                  onChange={(event) =>
                    setBenchmarkResultsDb(event.target.value)
                  }
                  placeholder="default"
                />
              </label>
              <label className="space-y-1 text-xs text-muted sm:col-span-2 xl:col-span-2">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.TrainedModelPath")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={benchmarkTrainedModelPath}
                  onChange={(event) =>
                    setBenchmarkTrainedModelPath(event.target.value)
                  }
                  placeholder="packages/training/checkpoints/eliza-1-0_8b/final"
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.MatrixOutput")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={benchmarkMatrixOutputDir}
                  onChange={(event) =>
                    setBenchmarkMatrixOutputDir(event.target.value)
                  }
                  placeholder="default"
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <input
                  type="checkbox"
                  checked={benchmarkDryRun}
                  onChange={(event) => setBenchmarkDryRun(event.target.checked)}
                />
                {t("finetuningview.DryRun")}
              </label>
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
                  <Button
                    variant="outline"
                    size="sm"
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
                  </Button>
                ) : null}
                {benchmarkResult.outputDir ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(benchmarkResult.outputDir),
                      );
                    }}
                  >
                    Open benchmark output
                  </Button>
                ) : null}
              </div>
            </div>
          )}
          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.BundleRepo")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={bundleStageRepoId}
                  onChange={(event) => setBundleStageRepoId(event.target.value)}
                  placeholder="elizaos/eliza-1"
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.BundleTier")}
                </span>
                <select
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={bundleStageTier}
                  onChange={(event) => setBundleStageTier(event.target.value)}
                >
                  <option value="0_8b">0_8b</option>
                  <option value="2b">2b</option>
                  <option value="4b">4b</option>
                  <option value="9b">9b</option>
                  <option value="27b">27b</option>
                  <option value="27b-256k">27b-256k</option>
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.LocalDir")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={bundleStageLocalDir}
                  onChange={(event) =>
                    setBundleStageLocalDir(event.target.value)
                  }
                  placeholder="/tmp/eliza-1-bundles"
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.MaxBytes")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={bundleStageMaxBytes}
                  onChange={(event) =>
                    setBundleStageMaxBytes(event.target.value)
                  }
                  inputMode="numeric"
                />
              </label>
              <label className="space-y-1 text-xs text-muted sm:col-span-2 xl:col-span-1">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.ManifestOutput")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={bundleStageOutputDir}
                  onChange={(event) =>
                    setBundleStageOutputDir(event.target.value)
                  }
                  placeholder="default"
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <input
                  type="checkbox"
                  checked={bundleStageApply}
                  onChange={(event) =>
                    setBundleStageApply(event.target.checked)
                  }
                />
                {t("finetuningview.Apply")}
              </label>
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
                <Button
                  variant="outline"
                  size="sm"
                  className={FINE_TUNING_ACTION_CLASS}
                  onClick={() => {
                    void openExternalUrl(
                      localViewerUrl(bundleStageResult.manifestPath),
                    );
                  }}
                >
                  Open bundle manifest
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={FINE_TUNING_ACTION_CLASS}
                  onClick={() => {
                    void openExternalUrl(
                      localViewerUrl(bundleStageResult.outputDir),
                    );
                  }}
                >
                  Open bundle output
                </Button>
                {bundleStageResult.plan?.bundleDir ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className={FINE_TUNING_ACTION_CLASS}
                    onClick={() => {
                      void openExternalUrl(
                        localViewerUrl(bundleStageResult.plan.bundleDir),
                      );
                    }}
                  >
                    Open bundle dir
                  </Button>
                ) : null}
              </div>
            </div>
          )}
          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.ActionBenchmarkFilter")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkFilter}
                  onChange={(event) =>
                    setActionBenchmarkFilter(event.target.value)
                  }
                  placeholder="case-id[,case-id]"
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.RunsPerCase")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkRunsPerCase}
                  onChange={(event) =>
                    setActionBenchmarkRunsPerCase(event.target.value)
                  }
                  inputMode="numeric"
                />
              </label>
              <label className="space-y-1 text-xs text-muted sm:col-span-2">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Output")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkOutputDir}
                  onChange={(event) =>
                    setActionBenchmarkOutputDir(event.target.value)
                  }
                  placeholder="default"
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Model")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkModelId}
                  onChange={(event) =>
                    setActionBenchmarkModelId(event.target.value)
                  }
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.BaseModel")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkBaseModelId}
                  onChange={(event) =>
                    setActionBenchmarkBaseModelId(event.target.value)
                  }
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.CollectionTiers")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkPairTiers}
                  onChange={(event) =>
                    setActionBenchmarkPairTiers(event.target.value)
                  }
                  placeholder={`${ELIZA_ONE_BENCHMARK_TIER_LIST} or all`}
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.RuntimeModel")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkRuntimeModel}
                  onChange={(event) =>
                    setActionBenchmarkRuntimeModel(event.target.value)
                  }
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.BaseRuntimeModel")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkBaseRuntimeModel}
                  onChange={(event) =>
                    setActionBenchmarkBaseRuntimeModel(event.target.value)
                  }
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Provider")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkProvider}
                  onChange={(event) =>
                    setActionBenchmarkProvider(event.target.value)
                  }
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.BaseUrl")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkBaseUrl}
                  onChange={(event) =>
                    setActionBenchmarkBaseUrl(event.target.value)
                  }
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Variant")}
                </span>
                <select
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkVariant}
                  onChange={(event) =>
                    setActionBenchmarkVariant(
                      event.target.value as "reference" | "base" | "trained",
                    )
                  }
                >
                  <option value="trained">trained</option>
                  <option value="base">base</option>
                  <option value="reference">reference</option>
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Tier")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkTier}
                  onChange={(event) =>
                    setActionBenchmarkTier(event.target.value)
                  }
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.Benchmark")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkMatrixBenchmark}
                  onChange={(event) =>
                    setActionBenchmarkMatrixBenchmark(event.target.value)
                  }
                />
              </label>
              <label className="space-y-1 text-xs text-muted sm:col-span-2">
                <span className="font-semibold uppercase tracking-[0.14em]">
                  {t("finetuningview.DatasetVersion")}
                </span>
                <input
                  className="h-10 w-full rounded-xl border border-border/60 bg-bg/50 px-3 text-sm text-txt outline-none focus:border-accent"
                  value={actionBenchmarkDatasetVersion}
                  onChange={(event) =>
                    setActionBenchmarkDatasetVersion(event.target.value)
                  }
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <input
                  type="checkbox"
                  checked={actionBenchmarkPairEnabled}
                  onChange={(event) =>
                    setActionBenchmarkPairEnabled(event.target.checked)
                  }
                />
                {t("finetuningview.PairBaseTrained")}
              </label>
              <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <input
                  type="checkbox"
                  checked={actionBenchmarkUseMocks}
                  onChange={(event) =>
                    setActionBenchmarkUseMocks(event.target.checked)
                  }
                />
                {t("finetuningview.UseMocks")}
              </label>
              <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <input
                  type="checkbox"
                  checked={actionBenchmarkCapture}
                  onChange={(event) =>
                    setActionBenchmarkCapture(event.target.checked)
                  }
                />
                {t("finetuningview.CaptureTrajectories")}
              </label>
              <label className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                <input
                  type="checkbox"
                  checked={actionBenchmarkDryRun}
                  onChange={(event) =>
                    setActionBenchmarkDryRun(event.target.checked)
                  }
                />
                {t("finetuningview.DryRun")}
              </label>
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
                <Button
                  variant="outline"
                  size="sm"
                  className={FINE_TUNING_ACTION_CLASS}
                  onClick={() => {
                    void openExternalUrl(
                      localViewerUrl(actionBenchmarkResult.reportJsonPath),
                    );
                  }}
                >
                  Open action report
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={FINE_TUNING_ACTION_CLASS}
                  onClick={() => {
                    void openExternalUrl(
                      localViewerUrl(actionBenchmarkResult.reportMarkdownPath),
                    );
                  }}
                >
                  Open action summary
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={FINE_TUNING_ACTION_CLASS}
                  onClick={() => {
                    void openExternalUrl(
                      localViewerUrl(actionBenchmarkResult.trajectoryDir),
                    );
                  }}
                >
                  Open action trajectories
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={FINE_TUNING_ACTION_CLASS}
                  onClick={() => {
                    void openExternalUrl(
                      localViewerUrl(actionBenchmarkResult.outputDir),
                    );
                  }}
                >
                  Open action output
                </Button>
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
          onBuildDataset={() => {
            void handleBuildDataset();
          }}
          onRefreshDatasets={() => {
            void loadDatasets();
          }}
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
          onStartJob={() => {
            void handleStartJob();
          }}
          onRefreshJobs={() => {
            void loadJobs();
            void loadStatus();
          }}
          jobs={jobs}
          selectedJobId={selectedJobId}
          setSelectedJobId={setSelectedJobId}
          cancellingJobId={cancellingJobId}
          onCancelJob={(jobId) => {
            void handleCancelJob(jobId);
          }}
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
          onImport={() => {
            void handleImportSelectedModel();
          }}
          onActivate={() => {
            void handleActivateSelectedModel();
          }}
          onBenchmark={() => {
            void handleBenchmarkSelectedModel();
          }}
          onSmokeTest={() => {
            void handleSmokeTestSelectedModel();
          }}
          t={t}
        />

        <LiveEventsPanel events={trainingEvents} t={t} />
      </div>
    </ContentLayout>
  );
}

export function FineTuningTuiView() {
  const [state, setState] = useState<Awaited<
    ReturnType<typeof loadTrainingTuiState>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastAction, setLastAction] = useState("boot");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadTrainingTuiState();
      setState(next);
      setLastAction("refresh");
    } catch (caught) {
      setState(null);
      setError(
        caught instanceof Error ? caught.message : "Training refresh failed",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeJobs =
    state?.jobs.jobs.filter(
      (job) => job.status === "running" || job.status === "queued",
    ) ?? [];
  const viewState = {
    viewType: "tui",
    viewId: "training",
    runtimeAvailable: state?.status.runtimeAvailable ?? false,
    runningJobs: state?.status.runningJobs ?? 0,
    queuedJobs: state?.status.queuedJobs ?? 0,
    datasetCount: state?.datasets.datasets.length ?? 0,
    jobCount: state?.jobs.jobs.length ?? 0,
    modelCount: state?.models.models.length ?? 0,
    trajectoryCount: state?.trajectories.total ?? 0,
    loading,
    lastAction,
    error,
  };

  return (
    <div
      data-view-state={JSON.stringify(viewState)}
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#cbd5e1",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        padding: 20,
      }}
    >
      <div style={{ color: "#7dd3fc", marginBottom: 4 }}>
        elizaos://training --type=tui
      </div>
      <div style={{ color: "#475569", marginBottom: 16 }}>
        {loading
          ? "loading"
          : state?.status.runtimeAvailable
            ? "runtime-ready"
            : "runtime-offline"}{" "}
        | {activeJobs.length} active jobs |{" "}
        {state?.datasets.datasets.length ?? 0} datasets |{" "}
        {state?.models.models.length ?? 0} models | {lastAction}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 1fr) minmax(320px, 1fr)",
          gap: 16,
        }}
      >
        <section
          aria-label="Training status"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <strong style={{ color: "#e2e8f0" }}>status</strong>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              style={{
                background: "transparent",
                color: "#a7f3d0",
                border: "1px solid rgba(167,243,208,0.45)",
                borderRadius: 4,
                padding: "4px 8px",
                cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              refresh
            </button>
          </div>
          {error && <div style={{ color: "#fca5a5" }}>{error}</div>}
          <div>
            runtime {state?.status.runtimeAvailable ? "ready" : "offline"}
          </div>
          <div>running {state?.status.runningJobs ?? 0}</div>
          <div>queued {state?.status.queuedJobs ?? 0}</div>
          <div>completed {state?.status.completedJobs ?? 0}</div>
          <div>failed {state?.status.failedJobs ?? 0}</div>

          <div style={{ color: "#a7f3d0", margin: "18px 0 8px" }}>
            trajectories
          </div>
          <div>
            {state?.trajectories.available ? "available" : "unavailable"} total{" "}
            {state?.trajectories.total ?? 0}
          </div>
          {(state?.trajectories.trajectories ?? [])
            .slice(0, 8)
            .map((trajectory) => (
              <div key={trajectory.id} style={{ padding: "5px 0" }}>
                {trajectory.trajectoryId} calls {trajectory.llmCallCount}
                {typeof trajectory.totalReward === "number"
                  ? ` reward ${trajectory.totalReward}`
                  : ""}
              </div>
            ))}
        </section>

        <section
          aria-label="Training work"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <strong style={{ color: "#e2e8f0" }}>jobs and models</strong>
          <div style={{ color: "#64748b", margin: "6px 0 14px" }}>
            commands: state | build-dataset | start-job | cancel-job |
            import-model | activate-model | benchmark-model | ingest-hf-dataset
            | feed-generate | run-scenarios | run-eval-comparison |
            run-collection | build-analysis-index | build-readiness-report |
            write-benchmark-matrix | run-benchmark-vs-cerebras |
            stage-eliza1-bundle | run-action-benchmark
          </div>
          <div style={{ color: "#a7f3d0", marginBottom: 8 }}>jobs</div>
          {(state?.jobs.jobs ?? []).slice(0, 10).map((job) => (
            <div
              key={job.id}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0,1fr) 10ch",
                gap: 10,
                borderTop: "1px solid rgba(125,211,252,0.14)",
                padding: "7px 0",
              }}
            >
              <span style={{ color: "#e2e8f0" }}>{job.id}</span>
              <span style={{ color: "#a7f3d0" }}>{job.status}</span>
              <span style={{ gridColumn: "1 / 3", color: "#94a3b8" }}>
                {job.phase} {Math.round(job.progress * 100)}% dataset{" "}
                {job.datasetId}
              </span>
            </div>
          ))}
          <div style={{ color: "#a7f3d0", margin: "18px 0 8px" }}>models</div>
          {(state?.models.models ?? []).slice(0, 10).map((model) => (
            <div key={model.id} style={{ padding: "5px 0" }}>
              {model.id} {model.backend}
              {model.active ? " active" : ""}
              {model.ollamaModel ? ` ollama ${model.ollamaModel}` : ""}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

async function loadTrainingTuiState(): Promise<{
  status: TrainingStatus;
  trajectories: TrainingTrajectoryList;
  datasets: { datasets: TrainingDatasetRecord[] };
  jobs: { jobs: TrainingJobRecord[] };
  models: { models: TrainingModelRecord[] };
}> {
  const [status, trajectories, datasets, jobs, models] = await Promise.all([
    client.getTrainingStatus(),
    client.listTrainingTrajectories({ limit: 25, offset: 0 }),
    client.listTrainingDatasets(),
    client.listTrainingJobs(),
    client.listTrainingModels(),
  ]);
  return {
    status,
    trajectories,
    datasets: { datasets: asArray(datasets.datasets) },
    jobs: { jobs: asArray(jobs.jobs) },
    models: { models: asArray(models.models) },
  };
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-training-state") {
    return { viewType: "tui", ...(await loadTrainingTuiState()) };
  }

  if (capability === "terminal-training-trajectory") {
    const trajectoryId =
      typeof params?.trajectoryId === "string"
        ? params.trajectoryId.trim()
        : "";
    if (!trajectoryId) throw new Error("trajectoryId is required");
    return {
      viewType: "tui",
      ...(await client.getTrainingTrajectory(trajectoryId)),
    };
  }

  if (capability === "terminal-training-build-dataset") {
    return {
      viewType: "tui",
      ...(await client.buildTrainingDataset({
        limit: typeof params?.limit === "number" ? params.limit : undefined,
        minLlmCallsPerTrajectory:
          typeof params?.minLlmCallsPerTrajectory === "number"
            ? params.minLlmCallsPerTrajectory
            : undefined,
      })),
    };
  }

  if (capability === "terminal-training-start-job") {
    const options: StartTrainingOptions = {};
    if (typeof params?.datasetId === "string")
      options.datasetId = params.datasetId;
    if (
      params?.backend === "mlx" ||
      params?.backend === "cuda" ||
      params?.backend === "cpu"
    ) {
      options.backend = params.backend;
    }
    if (typeof params?.model === "string") options.model = params.model;
    if (typeof params?.iterations === "number")
      options.iterations = params.iterations;
    if (typeof params?.batchSize === "number")
      options.batchSize = params.batchSize;
    if (typeof params?.learningRate === "number") {
      options.learningRate = params.learningRate;
    }
    return {
      viewType: "tui",
      ...(await client.startTrainingJob(options)),
    };
  }

  if (capability === "terminal-training-cancel-job") {
    const jobId = typeof params?.jobId === "string" ? params.jobId.trim() : "";
    if (!jobId) throw new Error("jobId is required");
    return { viewType: "tui", ...(await client.cancelTrainingJob(jobId)) };
  }

  if (capability === "terminal-training-import-model") {
    const modelId =
      typeof params?.modelId === "string" ? params.modelId.trim() : "";
    if (!modelId) throw new Error("modelId is required");
    return {
      viewType: "tui",
      ...(await client.importTrainingModelToOllama(modelId, {
        modelName:
          typeof params?.modelName === "string" ? params.modelName : undefined,
        baseModel:
          typeof params?.baseModel === "string" ? params.baseModel : undefined,
        ollamaUrl:
          typeof params?.ollamaUrl === "string" ? params.ollamaUrl : undefined,
      })),
    };
  }

  if (capability === "terminal-training-activate-model") {
    const modelId =
      typeof params?.modelId === "string" ? params.modelId.trim() : "";
    if (!modelId) throw new Error("modelId is required");
    return {
      viewType: "tui",
      ...(await client.activateTrainingModel(
        modelId,
        typeof params?.providerModel === "string"
          ? params.providerModel
          : undefined,
      )),
    };
  }

  if (capability === "terminal-training-benchmark-model") {
    const modelId =
      typeof params?.modelId === "string" ? params.modelId.trim() : "";
    if (!modelId) throw new Error("modelId is required");
    return {
      viewType: "tui",
      ...(await client.benchmarkTrainingModel(modelId)),
    };
  }

  if (capability === "terminal-training-build-analysis-index") {
    return {
      viewType: "tui",
      ...(await client.buildTrainingAnalysisIndex({
        roots: Array.isArray(params?.roots)
          ? params.roots.filter(
              (root): root is string => typeof root === "string",
            )
          : undefined,
        outputDir:
          typeof params?.outputDir === "string" ? params.outputDir : undefined,
        maxDepth:
          typeof params?.maxDepth === "number" ? params.maxDepth : undefined,
      })),
    };
  }

  if (capability === "terminal-training-build-readiness-report") {
    return {
      viewType: "tui",
      ...(await client.buildTrainingReadinessReport({
        roots: Array.isArray(params?.roots)
          ? params.roots.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : undefined,
        outputDir:
          typeof params?.outputDir === "string" ? params.outputDir : undefined,
        maxDepth:
          typeof params?.maxDepth === "number" ? params.maxDepth : undefined,
        reportOutputDir:
          typeof params?.reportOutputDir === "string"
            ? params.reportOutputDir
            : undefined,
        reportPath:
          typeof params?.reportPath === "string"
            ? params.reportPath
            : undefined,
      })),
    };
  }

  if (capability === "terminal-training-ingest-hf-dataset") {
    return {
      viewType: "tui",
      ...(await client.ingestHuggingFaceTrainingDataset({
        repoId: typeof params?.repoId === "string" ? params.repoId : undefined,
        revision:
          typeof params?.revision === "string" ? params.revision : undefined,
        files: Array.isArray(params?.files)
          ? params.files.filter(
              (file): file is string => typeof file === "string",
            )
          : undefined,
        outputDir:
          typeof params?.outputDir === "string" ? params.outputDir : undefined,
        token: typeof params?.token === "string" ? params.token : undefined,
        dryRun: params?.dryRun === true,
      })),
    };
  }

  if (capability === "terminal-training-feed-generate") {
    return {
      viewType: "tui",
      ...(await client.runFeedTrainingGeneration({
        workspaceRoot:
          typeof params?.workspaceRoot === "string"
            ? params.workspaceRoot
            : undefined,
        bun: typeof params?.bun === "string" ? params.bun : undefined,
        archetypes:
          typeof params?.archetypes === "string"
            ? params.archetypes
            : undefined,
        numAgents:
          typeof params?.numAgents === "number" ? params.numAgents : undefined,
        ticks: typeof params?.ticks === "number" ? params.ticks : undefined,
        parallel:
          typeof params?.parallel === "number" ? params.parallel : undefined,
        managerId:
          typeof params?.managerId === "string" ? params.managerId : undefined,
        cleanup: params?.cleanup === true,
        dryRun: params?.dryRun === true,
        outputDir:
          typeof params?.outputDir === "string" ? params.outputDir : undefined,
      })),
    };
  }

  if (capability === "terminal-training-run-scenarios") {
    return {
      viewType: "tui",
      ...(await client.runTrainingScenarios({
        workspaceRoot:
          typeof params?.workspaceRoot === "string"
            ? params.workspaceRoot
            : undefined,
        bun: typeof params?.bun === "string" ? params.bun : undefined,
        scenarioDir:
          typeof params?.scenarioDir === "string"
            ? params.scenarioDir
            : undefined,
        outputDir:
          typeof params?.outputDir === "string" ? params.outputDir : undefined,
        runId: typeof params?.runId === "string" ? params.runId : undefined,
        scenario:
          typeof params?.scenario === "string" ? params.scenario : undefined,
        fileGlobs: Array.isArray(params?.fileGlobs)
          ? params.fileGlobs.filter(
              (glob): glob is string => typeof glob === "string",
            )
          : undefined,
        exportNative:
          typeof params?.exportNative === "boolean"
            ? params.exportNative
            : undefined,
        useDeterministicProxy:
          typeof params?.useDeterministicProxy === "boolean"
            ? params.useDeterministicProxy
            : undefined,
        dryRun: params?.dryRun === true,
      })),
    };
  }

  if (capability === "terminal-training-run-eval-comparison") {
    const backend =
      params?.backend === "cpu" ||
      params?.backend === "mlx" ||
      params?.backend === "cuda"
        ? params.backend
        : undefined;
    return {
      viewType: "tui",
      ...(await client.runTrainingLocalEvalComparison({
        trainingRoot:
          typeof params?.trainingRoot === "string"
            ? params.trainingRoot
            : undefined,
        python: typeof params?.python === "string" ? params.python : undefined,
        manifestPath:
          typeof params?.manifestPath === "string"
            ? params.manifestPath
            : undefined,
        model: typeof params?.model === "string" ? params.model : undefined,
        trainedModelPath:
          typeof params?.trainedModelPath === "string"
            ? params.trainedModelPath
            : undefined,
        backend,
        promptFile:
          typeof params?.promptFile === "string"
            ? params.promptFile
            : undefined,
        maxTokens:
          typeof params?.maxTokens === "number" ? params.maxTokens : undefined,
        systemPrompt:
          typeof params?.systemPrompt === "string"
            ? params.systemPrompt
            : undefined,
        outputPath:
          typeof params?.outputPath === "string"
            ? params.outputPath
            : undefined,
        outputDir:
          typeof params?.outputDir === "string" ? params.outputDir : undefined,
        dryRun: params?.dryRun === true,
      })),
    };
  }

  if (capability === "terminal-training-run-collection") {
    return {
      viewType: "tui",
      ...(await client.runTrainingCollection({
        outputDir:
          typeof params?.outputDir === "string" ? params.outputDir : undefined,
        workspaceRoot:
          typeof params?.workspaceRoot === "string"
            ? params.workspaceRoot
            : undefined,
        preflightOnly:
          typeof params?.preflightOnly === "boolean"
            ? params.preflightOnly
            : undefined,
        preflightProbe:
          typeof params?.preflightProbe === "boolean"
            ? params.preflightProbe
            : undefined,
        includeHuggingFace:
          typeof params?.includeHuggingFace === "boolean"
            ? params.includeHuggingFace
            : undefined,
        includeFeed:
          typeof params?.includeFeed === "boolean"
            ? params.includeFeed
            : undefined,
        includeNaturalTrajectories:
          typeof params?.includeNaturalTrajectories === "boolean"
            ? params.includeNaturalTrajectories
            : undefined,
        includeTestTrajectories:
          typeof params?.includeTestTrajectories === "boolean"
            ? params.includeTestTrajectories
            : undefined,
        includeScenarios:
          typeof params?.includeScenarios === "boolean"
            ? params.includeScenarios
            : undefined,
        includeEvalComparison:
          typeof params?.includeEvalComparison === "boolean"
            ? params.includeEvalComparison
            : undefined,
        includeActionBenchmark:
          typeof params?.includeActionBenchmark === "boolean"
            ? params.includeActionBenchmark
            : undefined,
        includeBenchmarkVsCerebras:
          typeof params?.includeBenchmarkVsCerebras === "boolean"
            ? params.includeBenchmarkVsCerebras
            : undefined,
        includeEliza1ModelRegistry:
          typeof params?.includeEliza1ModelRegistry === "boolean"
            ? params.includeEliza1ModelRegistry
            : undefined,
        includeEliza1BundleStage:
          typeof params?.includeEliza1BundleStage === "boolean"
            ? params.includeEliza1BundleStage
            : undefined,
        includeBenchmarkMatrix:
          typeof params?.includeBenchmarkMatrix === "boolean"
            ? params.includeBenchmarkMatrix
            : undefined,
        huggingFace:
          params?.huggingFace &&
          typeof params.huggingFace === "object" &&
          !Array.isArray(params.huggingFace)
            ? params.huggingFace
            : undefined,
        feed:
          params?.feed &&
          typeof params.feed === "object" &&
          !Array.isArray(params.feed)
            ? params.feed
            : undefined,
        naturalTrajectories:
          params?.naturalTrajectories &&
          typeof params.naturalTrajectories === "object" &&
          !Array.isArray(params.naturalTrajectories)
            ? params.naturalTrajectories
            : undefined,
        testTrajectories:
          params?.testTrajectories &&
          typeof params.testTrajectories === "object" &&
          !Array.isArray(params.testTrajectories)
            ? params.testTrajectories
            : undefined,
        scenarios:
          params?.scenarios &&
          typeof params.scenarios === "object" &&
          !Array.isArray(params.scenarios)
            ? params.scenarios
            : undefined,
        evalComparison:
          params?.evalComparison &&
          typeof params.evalComparison === "object" &&
          !Array.isArray(params.evalComparison)
            ? params.evalComparison
            : undefined,
        actionBenchmark:
          params?.actionBenchmark &&
          typeof params.actionBenchmark === "object" &&
          !Array.isArray(params.actionBenchmark)
            ? params.actionBenchmark
            : undefined,
        actionBenchmarkPair:
          params?.actionBenchmarkPair &&
          typeof params.actionBenchmarkPair === "object" &&
          !Array.isArray(params.actionBenchmarkPair)
            ? params.actionBenchmarkPair
            : undefined,
        actionBenchmarkPairs: Array.isArray(params?.actionBenchmarkPairs)
          ? params.actionBenchmarkPairs.filter(
              (item) =>
                item !== null &&
                typeof item === "object" &&
                !Array.isArray(item),
            )
          : typeof params?.actionBenchmarkPairs === "string"
            ? elizaOneActionBenchmarkPairs(
                parseCollectionTierList(params.actionBenchmarkPairs),
              )
            : undefined,
        benchmarkVsCerebras:
          params?.benchmarkVsCerebras &&
          typeof params.benchmarkVsCerebras === "object" &&
          !Array.isArray(params.benchmarkVsCerebras)
            ? params.benchmarkVsCerebras
            : undefined,
        eliza1BundleStage:
          params?.eliza1BundleStage &&
          typeof params.eliza1BundleStage === "object" &&
          !Array.isArray(params.eliza1BundleStage)
            ? params.eliza1BundleStage
            : undefined,
        benchmarkMatrix:
          params?.benchmarkMatrix &&
          typeof params.benchmarkMatrix === "object" &&
          !Array.isArray(params.benchmarkMatrix)
            ? params.benchmarkMatrix
            : undefined,
      })),
    };
  }

  if (capability === "terminal-training-write-benchmark-matrix") {
    const rows = Array.isArray(params?.rows) ? params.rows : [];
    return {
      viewType: "tui",
      ...(await client.writeTrainingBenchmarkMatrix({
        rows: rows.filter(
          (
            row,
          ): row is {
            modelId: string;
            benchmark: string;
            score: number;
            variant: "reference" | "base" | "trained";
          } =>
            row !== null &&
            typeof row === "object" &&
            !Array.isArray(row) &&
            typeof (row as { modelId?: unknown }).modelId === "string" &&
            typeof (row as { benchmark?: unknown }).benchmark === "string" &&
            typeof (row as { score?: unknown }).score === "number" &&
            ((row as { variant?: unknown }).variant === "reference" ||
              (row as { variant?: unknown }).variant === "base" ||
              (row as { variant?: unknown }).variant === "trained"),
        ),
        outputDir:
          typeof params?.outputDir === "string" ? params.outputDir : undefined,
        referenceModelId:
          typeof params?.referenceModelId === "string"
            ? params.referenceModelId
            : undefined,
      })),
    };
  }

  if (capability === "terminal-training-run-benchmark-vs-cerebras") {
    const benchmark =
      params?.benchmark === "clawbench" ||
      params?.benchmark === "eliza_harness_action_selection" ||
      params?.benchmark === "hermes" ||
      params?.benchmark === "all"
        ? params.benchmark
        : undefined;
    const variants =
      params?.variants === "trained" ||
      params?.variants === "base" ||
      params?.variants === "both"
        ? params.variants
        : undefined;
    return {
      viewType: "tui",
      ...(await client.runTrainingBenchmarkVsCerebras({
        tiers: typeof params?.tiers === "string" ? params.tiers : undefined,
        benchmark,
        variants,
        maxSamples:
          typeof params?.maxSamples === "number"
            ? params.maxSamples
            : undefined,
        dryRun: params?.dryRun === true,
        outputDir:
          typeof params?.outputDir === "string" ? params.outputDir : undefined,
        resultsDb:
          typeof params?.resultsDb === "string" ? params.resultsDb : undefined,
        trainedModelPath:
          typeof params?.trainedModelPath === "string"
            ? params.trainedModelPath
            : undefined,
        datasetVersion:
          typeof params?.datasetVersion === "string"
            ? params.datasetVersion
            : undefined,
        codeCommit:
          typeof params?.codeCommit === "string"
            ? params.codeCommit
            : undefined,
        matrixOutputDir:
          typeof params?.matrixOutputDir === "string"
            ? params.matrixOutputDir
            : undefined,
      })),
    };
  }

  if (capability === "terminal-training-stage-eliza1-bundle") {
    return {
      viewType: "tui",
      ...(await client.stageEliza1Bundle({
        trainingRoot:
          typeof params?.trainingRoot === "string"
            ? params.trainingRoot
            : undefined,
        python: typeof params?.python === "string" ? params.python : undefined,
        repoId: typeof params?.repoId === "string" ? params.repoId : undefined,
        tier: typeof params?.tier === "string" ? params.tier : undefined,
        localDir:
          typeof params?.localDir === "string" ? params.localDir : undefined,
        outputDir:
          typeof params?.outputDir === "string" ? params.outputDir : undefined,
        maxBytes:
          typeof params?.maxBytes === "number" ? params.maxBytes : undefined,
        apply: params?.apply === true,
      })),
    };
  }

  if (capability === "terminal-training-run-action-benchmark") {
    return {
      viewType: "tui",
      ...(await client.runTrainingActionBenchmark({
        workspaceRoot:
          typeof params?.workspaceRoot === "string"
            ? params.workspaceRoot
            : undefined,
        bun: typeof params?.bun === "string" ? params.bun : undefined,
        outputDir:
          typeof params?.outputDir === "string" ? params.outputDir : undefined,
        useMocks:
          typeof params?.useMocks === "boolean" ? params.useMocks : undefined,
        forceTrajectoryCapture:
          params?.forceTrajectoryCapture === false ? false : undefined,
        filter: typeof params?.filter === "string" ? params.filter : undefined,
        runsPerCase:
          typeof params?.runsPerCase === "number"
            ? params.runsPerCase
            : undefined,
        provider:
          typeof params?.provider === "string" ? params.provider : undefined,
        modelId:
          typeof params?.modelId === "string" ? params.modelId : undefined,
        runtimeModel:
          typeof params?.runtimeModel === "string"
            ? params.runtimeModel
            : undefined,
        smallModel:
          typeof params?.smallModel === "string"
            ? params.smallModel
            : undefined,
        largeModel:
          typeof params?.largeModel === "string"
            ? params.largeModel
            : undefined,
        baseUrl:
          typeof params?.baseUrl === "string" ? params.baseUrl : undefined,
        variant:
          params?.variant === "reference" ||
          params?.variant === "base" ||
          params?.variant === "trained"
            ? params.variant
            : undefined,
        tier: typeof params?.tier === "string" ? params.tier : undefined,
        benchmark:
          typeof params?.benchmark === "string" ? params.benchmark : undefined,
        datasetVersion:
          typeof params?.datasetVersion === "string"
            ? params.datasetVersion
            : undefined,
        codeCommit:
          typeof params?.codeCommit === "string"
            ? params.codeCommit
            : undefined,
        dryRun: params?.dryRun === true,
      })),
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
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
    <div className="min-w-0 rounded-md border border-border/45 bg-card/35 p-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-foreground">
        {value}
      </div>
    </div>
  );
}

export function FineTuningDetailExtension({
  app,
}: AppDetailExtensionProps) {
  const [history, setHistory] = useState<ListTrainingCollectionsResponse | null>(
    null,
  );
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
      className="flex flex-col gap-3 rounded-md border border-border/45 bg-card/25 p-4"
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
              : "No saved collection runs found yet."}
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
        <div className="flex flex-col gap-2 rounded-md border border-border/40 bg-bg/20 p-3 text-xs text-muted">
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
            <div className="flex flex-col gap-1 rounded border border-border/35 bg-card/25 p-2">
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
                void openExternalUrl(localViewerUrl(latest.analysisIndexHtmlPath))
              }
            >
              Open analysis
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void openExternalUrl(localViewerUrl(latest.readmePath))}
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

registerDetailExtension(
  FINE_TUNING_DETAIL_PANEL_ID,
  FineTuningDetailExtension,
);
