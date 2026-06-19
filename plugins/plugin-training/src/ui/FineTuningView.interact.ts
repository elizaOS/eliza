// View-bundle `interact` capability handler, split out of FineTuningView.tsx so
// that file exports only React components and stays Fast-Refresh-compatible
// (Vite would full-reload a component file that also exports a plain function).
// The view bundle re-exports `interact` via ./training-view-bundle.ts.
import { client } from "@elizaos/ui";
import type { StartTrainingOptions } from "@elizaos/ui/api";
import { elizaOneActionBenchmarkPairs } from "../core/eliza1-benchmark-recipe.js";
import {
  loadTrainingTuiState,
  parseCollectionTierList,
} from "./FineTuningView.helpers";

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
