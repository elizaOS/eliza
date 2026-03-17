/**
 * Training Automation Pipeline
 *
 * Fully automated RL training pipeline:
 * 1. Monitor data collection
 * 2. Trigger training when ready
 * 3. Score with RULER
 * 4. Export data
 * 5. Train model
 * 6. Deploy new version
 * 7. Monitor performance
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getMarketDataAdapter, getTrainingDataAdapter } from "../adapter";
import { getExportGroupedForGRPO } from "../dependencies";
import { logger } from "../utils/logger";
import { benchmarkService } from "./BenchmarkService";
import { modelSelectionService } from "./ModelSelectionService";
import { rewardBackpropagationService } from "./RewardBackpropagationService";
import { rulerScoringService } from "./RulerScoringService";
import type {
  AutomationConfig,
  AutomationStatus,
  TrainingMonitoringStatus,
  TrainingReadinessResult,
  TrainingTriggerOptions,
  TrainingTriggerResult,
  TrajectoryStep,
} from "./types";
import { getCurrentWindowId, getPreviousWindowId } from "./window-utils";

export type { AutomationConfig };

export class AutomationPipeline {
  private config: AutomationConfig;
  private currentTrainingJob: string | null = null;

  constructor(config: Partial<AutomationConfig> = {}) {
    const envMinTrajectories = parseInt(
      process.env.TRAINING_MIN_TRAJECTORIES ?? "",
      10,
    );
    const envMinGroupSize = parseInt(
      process.env.TRAINING_MIN_GROUP_SIZE ?? "",
      10,
    );

    this.config = {
      minTrajectoriesForTraining:
        config.minTrajectoriesForTraining ??
        (Number.isFinite(envMinTrajectories) && envMinTrajectories > 0
          ? envMinTrajectories
          : 1),
      minGroupSize:
        config.minGroupSize ??
        (Number.isFinite(envMinGroupSize) && envMinGroupSize > 0
          ? envMinGroupSize
          : 1), // Keep at 1 for flexibility
      dataQualityThreshold: config.dataQualityThreshold ?? 0.95,
      autoTriggerTraining: config.autoTriggerTraining !== false,
      trainingInterval: config.trainingInterval || 24, // Daily by default
      baseModel: config.baseModel || "unsloth/Qwen3-4B-128K", // 4B params, 128K context - ideal for fine-tuning
      modelNamePrefix: config.modelNamePrefix || "eliza-agent",
      modelIdPrefix:
        config.modelIdPrefix ||
        process.env.TRAINING_MODEL_ID_PREFIX ||
        config.modelNamePrefix ||
        "eliza-agent",
      modelStoragePath:
        config.modelStoragePath ||
        path.resolve(process.cwd(), "storage/models"),
      dataStoragePath:
        config.dataStoragePath ||
        path.resolve(process.cwd(), "storage/training-data"),
      pythonProjectRoot:
        config.pythonProjectRoot ||
        process.env.TRAINING_PYTHON_ROOT ||
        path.resolve(process.cwd(), "packages/training/python"),
      trainerScriptPath:
        config.trainerScriptPath ||
        process.env.TRAINING_SCRIPT_PATH ||
        undefined,
      trainerPythonExecutable:
        config.trainerPythonExecutable ||
        process.env.TRAINING_PYTHON_EXECUTABLE ||
        (process.platform === "win32" ? "python" : "python3"),
      trainingMode:
        config.trainingMode ||
        (process.env.TRAINING_MODE as "atropos" | "tinker") ||
        "atropos",
      atroposApiUrl:
        config.atroposApiUrl ||
        process.env.ATROPOS_API_URL ||
        "http://localhost:8000",
      vllmPort:
        config.vllmPort || parseInt(process.env.VLLM_PORT || "9001", 10),
    };
  }

  /**
   * Check if we're ready to train
   */
  async checkTrainingReadiness(): Promise<TrainingReadinessResult> {
    const adapter = getTrainingDataAdapter();

    const scoredAndReady = await adapter.countScoredTrajectoriesReady();
    const unscored = await adapter.countUnscoredTrajectories();
    const scenarioGroups = await adapter.getScenarioGroups(
      this.config.minGroupSize,
    );
    const quality = await this.calculateDataQuality();

    const stats = {
      totalTrajectories: scoredAndReady,
      unscoredTrajectories: unscored,
      scenarioGroups: scenarioGroups.length,
      dataQuality: quality,
    };

    if (scoredAndReady < this.config.minTrajectoriesForTraining) {
      return {
        ready: false,
        reason: `Need ${this.config.minTrajectoriesForTraining - scoredAndReady} more trajectories`,
        stats,
      };
    }

    if (scenarioGroups.length < 10) {
      return {
        ready: false,
        reason: `Need more scenario groups (${scenarioGroups.length}/10 minimum)`,
        stats,
      };
    }

    if (quality < this.config.dataQualityThreshold) {
      return {
        ready: false,
        reason: `Data quality too low (${(quality * 100).toFixed(1)}% < ${this.config.dataQualityThreshold * 100}%)`,
        stats,
      };
    }

    return {
      ready: true,
      reason: "Ready to train!",
      stats,
    };
  }

  /**
   * Calculate data quality score
   */
  private async calculateDataQuality(): Promise<number> {
    const adapter = getTrainingDataAdapter();
    const sample = await adapter.sampleRecentTrajectories(50);

    if (sample.length === 0) return 0;

    let qualityScore = 0;
    let totalChecks = 0;

    for (const traj of sample) {
      // Validate stepsJson exists and is valid before parsing
      if (
        !traj.stepsJson ||
        traj.stepsJson === "null" ||
        traj.stepsJson === "[]"
      ) {
        continue; // Skip invalid trajectories
      }

      const steps: TrajectoryStep[] = JSON.parse(
        traj.stepsJson,
      ) as TrajectoryStep[];

      if (!Array.isArray(steps)) {
        continue; // Skip if not an array
      }

      // Check 1: Has steps
      totalChecks++;
      if (steps.length > 0) qualityScore++;

      // Check 2: Steps have LLM calls
      totalChecks++;
      const hasLLMCalls = steps.every(
        (s) => s.llmCalls && Array.isArray(s.llmCalls) && s.llmCalls.length > 0,
      );
      if (hasLLMCalls) qualityScore++;

      // Check 3: LLM calls have substantial prompts
      totalChecks++;
      const hasGoodPrompts = steps.every(
        (s) =>
          Array.isArray(s.llmCalls) &&
          s.llmCalls.every(
            (llm) =>
              llm.systemPrompt &&
              llm.systemPrompt.length > 50 &&
              llm.userPrompt &&
              llm.userPrompt.length > 100,
          ),
      );
      if (hasGoodPrompts) qualityScore++;

      // Check 4: Has provider accesses
      totalChecks++;
      const hasProviders = steps.some(
        (s) =>
          s.providerAccesses &&
          Array.isArray(s.providerAccesses) &&
          s.providerAccesses.length > 0,
      );
      if (hasProviders) qualityScore++;

      // Check 5: Actions have results
      totalChecks++;
      const hasResults = steps.every(
        (s) => s.action && (s.action.result || s.action.error),
      );
      if (hasResults) qualityScore++;
    }

    return qualityScore / totalChecks;
  }

  /**
   * Trigger training job
   */
  async triggerTraining(
    options: TrainingTriggerOptions = {},
  ): Promise<TrainingTriggerResult> {
    // Check readiness
    const readiness = await this.checkTrainingReadiness();

    if (!readiness.ready && !options.force) {
      return {
        success: false,
        error: readiness.reason,
      };
    }

    // If forcing but no trajectories at all, try to score some first
    if (
      options.force &&
      readiness.stats.totalTrajectories === 0 &&
      readiness.stats.unscoredTrajectories > 0
    ) {
      logger.info(
        "Force mode: Attempting to score unscored trajectories first",
        {
          unscored: readiness.stats.unscoredTrajectories,
        },
        "AutomationPipeline",
      );

      // Score recent trajectories
      const adapter = getTrainingDataAdapter();
      const recentWindowIds = await adapter.getUnscoredWindowIds(5);

      for (const windowId of recentWindowIds) {
        await rulerScoringService.scoreWindow(windowId);
      }

      // Re-check readiness after scoring
      const newReadiness = await this.checkTrainingReadiness();
      logger.info(
        "After scoring",
        {
          scored: newReadiness.stats.totalTrajectories,
          stillUnscored: newReadiness.stats.unscoredTrajectories,
        },
        "AutomationPipeline",
      );
    }

    // Use ModelSelectionService for smart model selection
    const modelSelection = await modelSelectionService.selectBaseModel();

    logger.info("Model selection for training", {
      strategy: modelSelection.strategy,
      modelPath: modelSelection.modelPath,
      bundleCount: modelSelection.metadata?.bundleCount,
    });

    // Get data limit based on bundle count
    const dataLimit = await modelSelectionService.getTrainingDataLimit();

    // Prepare data
    logger.info("Preparing training data...", {
      ...readiness.stats,
      selectedModel: modelSelection.modelPath,
      strategy: modelSelection.strategy,
      dataLimit,
    });

    const batchId = `batch-${Date.now()}`;
    // Use standardized window ID format (YYYY-MM-DDTHH:00)
    const windowId = getCurrentWindowId();

    // Export trajectories with data limit
    const maxTrajectories =
      dataLimit || options.batchSize || readiness.stats.totalTrajectories;

    const exportGroupedForGRPO = getExportGroupedForGRPO();
    const exportResult = await exportGroupedForGRPO({
      outputPath: `${this.config.dataStoragePath}/${batchId}`,
      minTrajectoriesPerGroup: this.config.minGroupSize,
      maxGroupSize: maxTrajectories,
    });

    if (!exportResult.success) {
      return {
        success: false,
        error: `Export failed: ${exportResult.error}`,
      };
    }

    // Create training batch record
    const adapterForBatch = getTrainingDataAdapter();
    const nextVersion = await this.getNextModelVersion();
    const trajectoryIds =
      await adapterForBatch.getTrajectoryIdsForTraining(maxTrajectories);

    const insertedBatchId = await adapterForBatch.insertBatch({
      id: batchId,
      batchId,
      scenarioId: windowId,
      baseModel: modelSelection.modelPath,
      modelVersion: nextVersion,
      trajectoryIds: JSON.stringify(trajectoryIds),
      rankingsJson: null,
      rewardsJson: JSON.stringify([]),
      trainingLoss: null,
      policyImprovement: null,
      status: "pending",
      error: null,
      createdAt: new Date(),
    });

    const batch = await adapterForBatch.getBatchById(insertedBatchId);
    if (!batch) {
      return {
        success: false,
        error: "Failed to create training batch record",
      };
    }

    // Determine training mode: 'tinker' for cloud-based or 'atropos' for local vLLM
    const trainingMode = this.config.trainingMode || "atropos";
    const useTinker = trainingMode.toLowerCase() === "tinker";

    // Trigger appropriate Python training script based on mode.
    // Allow explicit override for packaged/runtime deployments.
    const pythonScript =
      this.config.trainerScriptPath ||
      path.resolve(
        this.config.pythonProjectRoot ||
          path.resolve(process.cwd(), "packages/training/python"),
        "src",
        "training",
        useTinker ? "tinker_trainer.py" : "atropos_trainer.py",
      );

    try {
      await fs.access(pythonScript);
    } catch {
      return {
        success: false,
        error: `Training script not found: ${pythonScript}`,
      };
    }

    // Set environment variables for Python script
    const env = {
      ...process.env,
      MODE: "single",
      BATCH_ID: batchId,
      MODEL_VERSION: nextVersion,
      WINDOW_ID: windowId,
      BASE_MODEL: modelSelection.modelPath,
      MAX_EXAMPLES: dataLimit ? dataLimit.toString() : "2000",
      DATABASE_URL: process.env.DATABASE_URL || "",
      ATROPOS_API_URL: this.config.atroposApiUrl || "http://localhost:8000",
      VLLM_PORT: String(this.config.vllmPort || 9001),
      FORCE_TRAINING: options.force ? "true" : "false",
      MIN_AGENTS_PER_WINDOW: "1",
      TRAINING_MODE: trainingMode,
    };

    logger.info(
      useTinker
        ? "Training will use Tinker cloud-based GRPO"
        : "Training will use Atropos GRPO with vLLM",
      {
        trainingMode,
        ...(useTinker
          ? { model: env.BASE_MODEL }
          : {
              atroposUrl: env.ATROPOS_API_URL,
              vllmPort: env.VLLM_PORT,
              model: env.BASE_MODEL,
            }),
      },
      "AutomationPipeline",
    );

    const pythonCmd =
      this.config.trainerPythonExecutable ||
      (process.platform === "win32" ? "python" : "python3");

    const trainingProcess = spawn(pythonCmd, [pythonScript], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    // Capture and log training process output
    trainingProcess.stdout?.on("data", (data: Buffer) => {
      logger.info("Training stdout", { output: data.toString().trim() });
    });

    trainingProcess.stderr?.on("data", (data: Buffer) => {
      logger.warn("Training stderr", { output: data.toString().trim() });
    });

    trainingProcess.on("error", (error: Error) => {
      logger.error("Training process error", { error: error.message });
      getTrainingDataAdapter()
        .updateBatchStatus(
          batchId,
          "failed",
          `Process spawn failed: ${error.message}`,
        )
        .catch((err: unknown) =>
          logger.error("Failed to update batch status", {
            error: err instanceof Error ? err : String(err),
          }),
        );
    });

    trainingProcess.unref();

    this.currentTrainingJob = batch.id;

    logger.info("Training job triggered", {
      batchId: batch.id,
      version: nextVersion,
      trajectories: exportResult.trajectoriesExported,
    });

    return {
      success: true,
      jobId: batch.id,
    };
  }

  /**
   * Get next model version
   */
  private async getNextModelVersion(): Promise<string> {
    const latestModel = await getTrainingDataAdapter().getLatestModel();

    if (!latestModel) {
      return "v1.0.0";
    }

    // Increment patch version
    const [major, minor, patch] = latestModel.version
      .substring(1)
      .split(".")
      .map(Number);
    const patchNum = patch ?? 0;
    return `v${major}.${minor}.${patchNum + 1}`;
  }

  /**
   * Monitor training job.
   *
   * Reads the training metrics log file written by the Python trainer to
   * derive real progress instead of returning hardcoded values.
   */
  async monitorTraining(batchId: string): Promise<TrainingMonitoringStatus> {
    const batch = await getTrainingDataAdapter().getBatchById(batchId);

    if (!batch) {
      return { status: "not_found" };
    }

    // Terminal states – return immediately
    if (batch.status === "completed") {
      return { status: "completed", progress: 1.0, error: undefined };
    }
    if (batch.status === "failed") {
      return {
        status: "failed",
        progress: 0,
        error: batch.error || "Training failed",
      };
    }
    if (batch.status === "pending") {
      return { status: "pending", progress: 0 };
    }

    // For 'training' status, attempt to read the metrics log written by
    // atropos_trainer.py / tinker_trainer.py to get real step counts.
    let progress = 0;
    let eta: number | undefined;

    const metricsLogPath = path.resolve(
      this.config.dataStoragePath,
      batchId,
      "training_metrics.jsonl",
    );

    try {
      const logContent = await fs.readFile(metricsLogPath, "utf-8");
      const lines = logContent.trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        if (lastLine) {
          const lastMetric = JSON.parse(lastLine) as {
            step?: number;
            total_steps?: number;
            elapsed_ms?: number;
          };
          if (
            typeof lastMetric.step === "number" &&
            typeof lastMetric.total_steps === "number" &&
            lastMetric.total_steps > 0
          ) {
            progress = lastMetric.step / lastMetric.total_steps;
            // Estimate remaining time from elapsed
            if (typeof lastMetric.elapsed_ms === "number" && progress > 0) {
              const totalEstimatedMs = lastMetric.elapsed_ms / progress;
              eta = Math.max(0, totalEstimatedMs - lastMetric.elapsed_ms);
            }
          }
        }
      }
    } catch {
      // Log file doesn't exist yet or is unreadable – training may have
      // just started. Return an honest "unknown progress" instead of faking.
      progress = 0;
    }

    return {
      status: batch.status,
      progress,
      eta,
      error: batch.error || undefined,
    };
  }

  /**
   * Clean up export files for a specific batch to prevent disk accumulation.
   *
   * Only removes the batch-specific subdirectory, not the entire export root.
   */
  private async cleanupExportFiles(batchId: string): Promise<void> {
    const batchDir = path.resolve(this.config.dataStoragePath, batchId);
    try {
      await fs.access(batchDir);
    } catch {
      // Directory doesn't exist – nothing to clean
      return;
    }

    try {
      const files = await fs.readdir(batchDir);
      for (const file of files) {
        const filePath = path.join(batchDir, file);
        await fs.unlink(filePath);
      }
      await fs.rmdir(batchDir);
      logger.info(
        "Cleaned up export files",
        { batchId, filesRemoved: files.length, dir: batchDir },
        "AutomationPipeline",
      );
    } catch (err) {
      logger.warn("Failed to clean up export files", {
        batchId,
        dir: batchDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Automation loop (called by cron)
   */
  async runAutomationCycle(): Promise<void> {
    logger.info("Running automation cycle");

    // Check if training is already running
    if (this.currentTrainingJob) {
      const status = await this.monitorTraining(this.currentTrainingJob);
      if (status.status === "completed") {
        await this.deployModel(this.currentTrainingJob);
        await this.cleanupExportFiles(this.currentTrainingJob);
        this.currentTrainingJob = null;
      } else if (status.status === "failed") {
        logger.error("Training job failed", {
          batchId: this.currentTrainingJob,
        });
        await this.cleanupExportFiles(this.currentTrainingJob);
        this.currentTrainingJob = null;
      }
      return;
    }

    // Check for newly completed batches (Python script may have completed)
    const da = getTrainingDataAdapter();
    const recentBatches = await da.getRecentlyCompletedBatches(24);
    const newlyCompleted = recentBatches[0];

    if (newlyCompleted) {
      const alreadyDeployed = await da.getModelByBatchAndStatus(
        newlyCompleted.batchId,
        "deployed",
      );

      if (!alreadyDeployed) {
        logger.info("Found newly completed training batch", {
          batchId: newlyCompleted.batchId,
        });
        await this.deployModel(newlyCompleted.batchId);
      }
    }

    // Check if we should trigger training
    const readiness = await this.checkTrainingReadiness();

    if (readiness.ready && this.config.autoTriggerTraining) {
      const lastCompleted = await da.getLastCompletedBatch();
      const hoursSinceLastTraining = lastCompleted?.completedAt
        ? (Date.now() - lastCompleted.completedAt.getTime()) / (1000 * 60 * 60)
        : 999;

      if (hoursSinceLastTraining >= this.config.trainingInterval) {
        logger.info("Triggering automatic training", readiness.stats);
        await this.triggerTraining();
      }
    }

    // Track market outcomes for recent windows (optional — only if market adapter registered)
    const marketAdapter = getMarketDataAdapter();
    if (marketAdapter) {
      const { MarketOutcomesTracker: MOT } = await import(
        "./MarketOutcomesTracker"
      );
      const outcomesTracker = new MOT();
      const synced = await outcomesTracker.syncRecentWindows(24);
      if (synced > 0) {
        logger.info("Synced market outcomes for windows", {
          windowsSynced: synced,
        });
      }

      const processed =
        await rewardBackpropagationService.processPendingWindows();
      if (processed > 0) {
        logger.info("Updated rewards for trajectories", {
          windowsProcessed: processed,
        });
      }
    }

    // Score trajectories using RULER framework
    for (let hoursAgo = 0; hoursAgo < 24; hoursAgo++) {
      const windowId = getPreviousWindowId(hoursAgo);
      const scored = await rulerScoringService.scoreWindow(windowId);
      if (scored > 0) {
        logger.info("Scored trajectories with RULER", { windowId, scored });
      }
    }

    await this.runHealthChecks();
  }

  /**
   * Deploy trained model.
   *
   * The model is created by the Python training script. This method marks
   * trajectories as used and updates the training batch status.
   */
  private async deployModel(batchId: string): Promise<void> {
    const da = getTrainingDataAdapter();
    const batch = await da.getBatchById(batchId);

    if (!batch) {
      logger.warn("Batch not found for deployment", { batchId });
      return;
    }

    const model = await da.getModelByBatchAndStatus(batch.id, "ready");

    if (!model) {
      logger.warn("Model not found for batch", { batchId });
      return;
    }

    logger.info("Deploying model", {
      version: batch.modelVersion,
      modelId: model.modelId,
      batchId,
    });

    // Mark trajectories as used
    let trajectoryIds: string[];
    if (
      !batch.trajectoryIds ||
      batch.trajectoryIds === "null" ||
      batch.trajectoryIds === "[]"
    ) {
      logger.warn("Training batch has invalid trajectoryIds", {
        batchId: batch.id,
      });
      trajectoryIds = [];
    } else {
      trajectoryIds = JSON.parse(batch.trajectoryIds) as string[];
      if (!Array.isArray(trajectoryIds)) {
        logger.warn("Training batch trajectoryIds is not an array", {
          batchId: batch.id,
        });
        trajectoryIds = [];
      }
    }

    if (trajectoryIds.length > 0) {
      await da.markTrajectoriesAsUsed(trajectoryIds, batch.id);
    }

    await da.updateModelStatus(model.modelId, "deployed", {
      deployedAt: new Date(),
    });

    logger.info("Model deployed", {
      version: batch.modelVersion,
      modelId: model.modelId,
    });
  }

  /**
   * Benchmark and conditionally deploy trained model
   * Only deploys if performance meets threshold
   */
  async benchmarkAndDeploy(
    batchId: string,
    autoDeploy = true,
  ): Promise<{
    benchmarked: boolean;
    deployed: boolean;
    reason?: string;
  }> {
    const da = getTrainingDataAdapter();
    const batch = await da.getBatchById(batchId);

    if (!batch) {
      return { benchmarked: false, deployed: false, reason: "Batch not found" };
    }

    const model = await da.getModelByBatchAndStatus(batch.id, "ready");

    if (!model) {
      return { benchmarked: false, deployed: false, reason: "Model not found" };
    }

    // Benchmark the model
    logger.info(
      "Benchmarking model...",
      { modelId: model.modelId },
      "AutomationPipeline",
    );
    const benchmarkResults = await benchmarkService.benchmarkModel(
      model.modelId,
    );

    // Compare with previous models
    const comparison = await benchmarkService.compareModels(model.modelId);

    logger.info(
      "Benchmark complete",
      {
        modelId: model.modelId,
        score: benchmarkResults.benchmarkScore,
        shouldDeploy: comparison.shouldDeploy,
        reason: comparison.reason,
      },
      "AutomationPipeline",
    );

    // Deploy if performance is good enough (and autoDeploy is enabled)
    if (comparison.shouldDeploy && autoDeploy) {
      await this.deployModel(batchId);
      return {
        benchmarked: true,
        deployed: true,
        reason: comparison.reason,
      };
    }

    return {
      benchmarked: true,
      deployed: false,
      reason: comparison.reason || "Performance below threshold",
    };
  }

  /**
   * Get model selection info for next training
   */
  async getModelSelectionInfo() {
    const selection = await modelSelectionService.selectBaseModel();
    const summary = await modelSelectionService.getSelectionSummary();

    return {
      success: true,
      selection,
      summary,
    };
  }

  /**
   * Run health checks
   */
  private async runHealthChecks(): Promise<void> {
    const da = getTrainingDataAdapter();
    const dbOk = await da.healthCheck();
    if (!dbOk) {
      logger.warn("Health check: database unreachable");
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const last1h = await da.countTrajectoriesSince(oneHourAgo);
    if (last1h < 1) {
      logger.warn("Low data collection rate", { trajectoriesLastHour: last1h });
    }

    // Ensure storage directories exist
    await fs.mkdir(this.config.modelStoragePath, { recursive: true });
    await fs.mkdir(this.config.dataStoragePath, { recursive: true });
  }

  /**
   * Get automation status
   */
  async getStatus(): Promise<AutomationStatus> {
    const da = getTrainingDataAdapter();

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const last24h = await da.countTrajectoriesSince(twentyFourHoursAgo);
    const last7d = await da.countTrajectoriesSince(sevenDaysAgo);

    const lastCompleted = await da.getLastCompletedBatch();
    const latestModel = await da.getLatestModel();
    const deployedCount = await da.countDeployedModels();
    const trainingCount = await da.countTrainingBatches();

    const dbHealthy = await da.healthCheck();

    let storageHealthy = false;
    try {
      await fs.access(this.config.modelStoragePath);
      storageHealthy = true;
    } catch {
      try {
        await fs.mkdir(this.config.modelStoragePath, { recursive: true });
        storageHealthy = true;
      } catch {
        storageHealthy = false;
      }
    }

    let atroposHealthy = false;
    if (this.config.atroposApiUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(`${this.config.atroposApiUrl}/health`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        atroposHealthy = resp.ok;
      } catch {
        atroposHealthy = false;
      }
    }

    return {
      dataCollection: {
        last24h,
        last7d,
        ratePerHour: last24h / 24,
      },
      training: {
        currentJob: this.currentTrainingJob,
        lastCompleted: lastCompleted?.completedAt || null,
        nextScheduled: lastCompleted?.completedAt
          ? new Date(
              lastCompleted.completedAt.getTime() +
                this.config.trainingInterval * 60 * 60 * 1000,
            )
          : null,
      },
      models: {
        latest: latestModel?.version || null,
        deployed: deployedCount,
        training: trainingCount,
      },
      health: {
        database: dbHealthy,
        storage: storageHealthy,
        atropos: atroposHealthy,
      },
    };
  }
}

// Singleton
export const automationPipeline = new AutomationPipeline();
