/**
 * Training Pipeline – public helpers
 *
 * IMPORTANT: All heavy modules (AutomationPipeline, ModelDeployer) are loaded
 * lazily so that importing this file does NOT trigger a database connection.
 * Consumers that only need types or lightweight utilities can import
 * "@elizaos/training" without side-effects.
 */

import type { AutomationPipeline } from "./AutomationPipeline";
import type { DeploymentOptions, DeploymentResult } from "./ModelDeployer";
import type {
  AutomationStatus,
  TrainingMonitoringStatus,
  TrainingReadinessResult,
  TrainingTriggerOptions,
  TrainingTriggerResult,
} from "./types";

export type NextTrainingModelSelection = Awaited<
  ReturnType<AutomationPipeline["getModelSelectionInfo"]>
>;

// ---------------------------------------------------------------------------
// Lazy singletons – only resolved on first call to avoid DB side-effects at
// module-load time.
// ---------------------------------------------------------------------------

let _pipeline: AutomationPipeline | null = null;

async function getPipeline(): Promise<AutomationPipeline> {
  if (!_pipeline) {
    const mod = await import("./AutomationPipeline");
    _pipeline = mod.automationPipeline;
  }
  return _pipeline;
}

async function getDeployer() {
  const mod = await import("./ModelDeployer");
  return mod.modelDeployer;
}

/**
 * Check whether the current trajectory set is ready for training.
 */
export async function checkTrainingReadiness(): Promise<TrainingReadinessResult> {
  const pipeline = await getPipeline();
  return pipeline.checkTrainingReadiness();
}

/**
 * Trigger a new training job.
 */
export async function triggerTraining(
  options: TrainingTriggerOptions = {},
): Promise<TrainingTriggerResult> {
  const pipeline = await getPipeline();
  return pipeline.triggerTraining(options);
}

/**
 * Monitor a training batch by its batch id.
 */
export async function monitorTrainingJob(
  batchId: string,
): Promise<TrainingMonitoringStatus> {
  const pipeline = await getPipeline();
  return pipeline.monitorTraining(batchId);
}

/**
 * Get summarized status for automation, jobs, and model health.
 */
export async function getAutomationPipelineStatus(): Promise<AutomationStatus> {
  const pipeline = await getPipeline();
  return pipeline.getStatus();
}

/**
 * Get model-selection metadata for the next run.
 */
export async function getNextTrainingModelSelection(): Promise<{
  success: boolean;
  selection: NextTrainingModelSelection["selection"];
  summary: NextTrainingModelSelection["summary"];
}> {
  const pipeline = await getPipeline();
  return pipeline.getModelSelectionInfo();
}

/**
 * Run benchmark and deploy the model only if it passes thresholds.
 */
export async function benchmarkAndMaybeDeployModel(
  batchId: string,
  autoDeploy = true,
): Promise<{
  benchmarked: boolean;
  deployed: boolean;
  reason?: string;
}> {
  const pipeline = await getPipeline();
  return pipeline.benchmarkAndDeploy(batchId, autoDeploy);
}

/**
 * Deploy a specific model version using the deployment strategy options.
 */
export async function deployModelVersion(
  options: DeploymentOptions,
): Promise<DeploymentResult> {
  const deployer = await getDeployer();
  return deployer.deploy(options);
}

/**
 * Roll back from one version to another.
 */
export async function rollbackModelVersion(
  currentVersion: string,
  targetVersion: string,
): Promise<DeploymentResult> {
  const deployer = await getDeployer();
  return deployer.rollback(currentVersion, targetVersion);
}
