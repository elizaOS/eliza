import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * Vertex AI fine-tuning pipeline for Gemini models.
 *
 * Supports:
 * - Gemini 2.5 Flash Lite (shouldRespond + context routing)
 * - Gemini 2.5 Flash (planner/action selection)
 *
 * Flow:
 * 1. Upload training JSONL to GCS
 * 2. Create a supervised tuning job
 * 3. Poll for completion
 * 4. Deploy the tuned model endpoint
 *
 * Requires:
 * - GOOGLE_CLOUD_PROJECT
 * - GOOGLE_CLOUD_REGION (defaults to us-central1)
 * - GOOGLE_APPLICATION_CREDENTIALS or gcloud auth
 *
 * Docs:
 * - https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini-use-supervised-tuning
 * - https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-lite
 */

export interface VertexTuningConfig {
  /** GCP project ID */
  projectId: string;
  /** GCP region (default: us-central1) */
  region?: string;
  /** GCS bucket for training data */
  gcsBucket: string;
  /** Base model to fine-tune */
  baseModel: "gemini-2.5-flash-lite" | "gemini-2.5-flash";
  /** Training data JSONL file path (local) */
  trainingDataPath: string;
  /** Optional validation data JSONL file path */
  validationDataPath?: string;
  /** Number of training epochs (default: 3) */
  epochs?: number;
  /** Learning rate multiplier (default: 1.0) */
  learningRateMultiplier?: number;
  /** Display name for the tuned model */
  displayName: string;
  /** Access token for API calls (from gcloud auth) */
  accessToken?: string;
}

export type VertexTuningSlot =
  | "should_respond"
  | "response_handler"
  | "action_planner"
  | "planner"
  | "response"
  | "media_description";

export type VertexTuningScope = "global" | "organization" | "user";

export interface TuningJob {
  name: string;
  state:
    | "JOB_STATE_PENDING"
    | "JOB_STATE_RUNNING"
    | "JOB_STATE_SUCCEEDED"
    | "JOB_STATE_FAILED"
    | "JOB_STATE_CANCELLED";
  tunedModelDisplayName: string;
  tunedModelEndpointName?: string;
  createTime: string;
  updateTime: string;
  error?: { code: number; message: string };
}

export interface TunedModelEndpoint {
  /** The full resource name */
  name: string;
  /** The model ID usable in API calls */
  model: string;
  /** The endpoint for inference */
  endpoint: string;
}

export interface VertexModelPreferencePatch {
  scope: VertexTuningScope;
  slot: VertexTuningSlot;
  ownerId?: string;
  modelPreferences: {
    nanoModel?: string;
    smallModel?: string;
    mediumModel?: string;
    largeModel?: string;
    megaModel?: string;
    responseHandlerModel?: string;
    shouldRespondModel?: string;
    actionPlannerModel?: string;
    plannerModel?: string;
    responseModel?: string;
    mediaDescriptionModel?: string;
  };
}

export interface VertexTuningOrchestrationConfig extends VertexTuningConfig {
  slot?: VertexTuningSlot;
  scope?: VertexTuningScope;
  ownerId?: string;
}

export interface VertexTuningOrchestrationResult {
  job: TuningJob;
  slot: VertexTuningSlot;
  scope: VertexTuningScope;
  recommendedModelId: string;
  modelPreferencePatch: VertexModelPreferencePatch;
}

export function normalizeVertexBaseModel(
  baseModel: string | undefined,
  slot: VertexTuningSlot = "should_respond",
): VertexTuningConfig["baseModel"] {
  if (baseModel === "gemini-2.5-flash" || baseModel === "flash") {
    return "gemini-2.5-flash";
  }
  if (baseModel === "gemini-2.5-flash-lite" || baseModel === "flash-lite") {
    return "gemini-2.5-flash-lite";
  }

  switch (slot) {
    case "action_planner":
    case "planner":
    case "response":
      return "gemini-2.5-flash";
    case "media_description":
    case "response_handler":
    case "should_respond":
    default:
      return "gemini-2.5-flash-lite";
  }
}

export function buildVertexModelPreferencePatch(params: {
  slot: VertexTuningSlot;
  tunedModelId: string;
  scope?: VertexTuningScope;
  ownerId?: string;
}): VertexModelPreferencePatch {
  const scope = params.scope ?? "global";
  const modelPreferences: VertexModelPreferencePatch["modelPreferences"] = {};

  switch (params.slot) {
    case "should_respond":
    case "response_handler":
      modelPreferences.responseHandlerModel = params.tunedModelId;
      modelPreferences.shouldRespondModel = params.tunedModelId;
      break;
    case "action_planner":
    case "planner":
      modelPreferences.actionPlannerModel = params.tunedModelId;
      modelPreferences.plannerModel = params.tunedModelId;
      break;
    case "response":
      modelPreferences.responseModel = params.tunedModelId;
      break;
    case "media_description":
      modelPreferences.mediaDescriptionModel = params.tunedModelId;
      break;
  }

  return {
    scope,
    slot: params.slot,
    ownerId: params.ownerId,
    modelPreferences,
  };
}

/**
 * Get a Google Cloud access token using gcloud CLI or application default credentials.
 */
async function getAccessToken(providedToken?: string): Promise<string> {
  if (providedToken) return providedToken;

  // Try gcloud CLI
  try {
    const proc = spawn("gcloud", ["auth", "print-access-token"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Uint8Array[] = [];
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    const code = await new Promise<number | null>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", resolve);
    });
    const text = Buffer.concat(stdoutChunks).toString("utf8");

    if (code === 0 && text.trim()) {
      return text.trim();
    }
  } catch {
    // gcloud not available
  }

  throw new Error(
    "No access token available. Set GOOGLE_ACCESS_TOKEN or run 'gcloud auth login'.",
  );
}

/**
 * Upload a local file to GCS.
 */
export async function uploadToGCS(
  localPath: string,
  bucket: string,
  objectName: string,
  accessToken: string,
): Promise<string> {
  const content = await readFile(localPath);

  const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/octet-stream",
    },
    body: content,
  });

  if (!response.ok) {
    throw new Error(
      `GCS upload failed: ${response.status} ${await response.text()}`,
    );
  }

  return `gs://${bucket}/${objectName}`;
}

/**
 * Create a supervised tuning job on Vertex AI.
 */
export async function createTuningJob(
  config: VertexTuningConfig,
): Promise<TuningJob> {
  const region = config.region ?? "us-central1";
  const accessToken = await getAccessToken(config.accessToken);

  // Upload training data to GCS
  const timestamp = Date.now();
  const trainingGcsUri = await uploadToGCS(
    config.trainingDataPath,
    config.gcsBucket,
    `tuning-data/${config.displayName}/${timestamp}/training.jsonl`,
    accessToken,
  );

  let validationGcsUri: string | undefined;
  if (config.validationDataPath) {
    validationGcsUri = await uploadToGCS(
      config.validationDataPath,
      config.gcsBucket,
      `tuning-data/${config.displayName}/${timestamp}/validation.jsonl`,
      accessToken,
    );
  }

  // Map our model names to Vertex AI model IDs
  const modelMap: Record<string, string> = {
    "gemini-2.5-flash-lite": "gemini-2.5-flash-lite-preview-06-17",
    "gemini-2.5-flash": "gemini-2.5-flash-preview-04-17",
  };
  const sourceModel = `publishers/google/models/${modelMap[config.baseModel] ?? config.baseModel}`;

  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/${region}/tuningJobs`;

  const body: Record<string, unknown> = {
    baseModel: sourceModel,
    supervisedTuningSpec: {
      trainingDatasetUri: trainingGcsUri,
      ...(validationGcsUri ? { validationDatasetUri: validationGcsUri } : {}),
      hyperParameters: {
        epochCount: config.epochs ?? 3,
        learningRateMultiplier: config.learningRateMultiplier ?? 1.0,
      },
    },
    tunedModelDisplayName: config.displayName,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `Vertex AI tuning job creation failed: ${response.status} ${await response.text()}`,
    );
  }

  return (await response.json()) as TuningJob;
}

/**
 * Check the status of a tuning job.
 */
export async function getTuningJobStatus(
  jobName: string,
  accessToken?: string,
): Promise<TuningJob> {
  const token = await getAccessToken(accessToken);

  const response = await fetch(
    `https://aiplatform.googleapis.com/v1/${jobName}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to get tuning job status: ${response.status} ${await response.text()}`,
    );
  }

  return (await response.json()) as TuningJob;
}

/**
 * List all tuning jobs for the project.
 */
export async function listTuningJobs(
  projectId: string,
  region: string = "us-central1",
  accessToken?: string,
): Promise<TuningJob[]> {
  const token = await getAccessToken(accessToken);

  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/tuningJobs`;

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to list tuning jobs: ${response.status} ${await response.text()}`,
    );
  }

  const data = (await response.json()) as { tuningJobs?: TuningJob[] };
  return data.tuningJobs ?? [];
}

/**
 * Poll a tuning job until completion.
 */
export async function waitForTuningJob(
  jobName: string,
  options?: {
    pollIntervalMs?: number;
    maxWaitMs?: number;
    accessToken?: string;
    onPoll?: (job: TuningJob) => void;
  },
): Promise<TuningJob> {
  const pollInterval = options?.pollIntervalMs ?? 60_000; // 1 minute
  const maxWait = options?.maxWaitMs ?? 24 * 60 * 60_000; // 24 hours
  const startTime = Date.now();

  while (true) {
    const job = await getTuningJobStatus(jobName, options?.accessToken);
    options?.onPoll?.(job);

    if (
      job.state === "JOB_STATE_SUCCEEDED" ||
      job.state === "JOB_STATE_FAILED" ||
      job.state === "JOB_STATE_CANCELLED"
    ) {
      return job;
    }

    if (Date.now() - startTime > maxWait) {
      throw new Error(`Tuning job timed out after ${maxWait}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

/**
 * Full pipeline: generate data, upload, tune, and return the endpoint.
 */
export async function runFullTuningPipeline(
  config: VertexTuningConfig & {
    onProgress?: (stage: string, detail: string) => void;
  },
): Promise<{ job: TuningJob; endpoint?: string }> {
  const progress = config.onProgress ?? (() => {});

  progress("upload", "Uploading training data to GCS...");
  const job = await createTuningJob(config);
  progress("submitted", `Tuning job created: ${job.name}`);

  progress("training", "Waiting for tuning job to complete...");
  const finalJob = await waitForTuningJob(job.name, {
    accessToken: config.accessToken,
    onPoll: (j) =>
      progress("training", `Job state: ${j.state} (updated: ${j.updateTime})`),
  });

  if (finalJob.state === "JOB_STATE_SUCCEEDED") {
    progress(
      "complete",
      `Tuning succeeded! Endpoint: ${finalJob.tunedModelEndpointName}`,
    );
    return { job: finalJob, endpoint: finalJob.tunedModelEndpointName };
  }

  progress("failed", `Tuning failed: ${finalJob.error?.message ?? "unknown"}`);
  return { job: finalJob };
}

export async function orchestrateVertexTuning(
  config: VertexTuningOrchestrationConfig,
): Promise<VertexTuningOrchestrationResult> {
  const slot = config.slot ?? "should_respond";
  const scope = config.scope ?? "global";
  const job = await createTuningJob({
    ...config,
    baseModel: normalizeVertexBaseModel(config.baseModel, slot),
  });

  const recommendedModelId =
    job.tunedModelEndpointName?.trim() ||
    job.tunedModelDisplayName?.trim() ||
    config.displayName;

  return {
    job,
    slot,
    scope,
    recommendedModelId,
    modelPreferencePatch: buildVertexModelPreferencePatch({
      slot,
      tunedModelId: recommendedModelId,
      scope,
      ownerId: config.ownerId,
    }),
  };
}
