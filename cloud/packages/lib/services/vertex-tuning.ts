import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface VertexTuningConfig {
  projectId: string;
  region?: string;
  gcsBucket: string;
  baseModel: "gemini-2.5-flash-lite" | "gemini-2.5-flash";
  trainingDataPath: string;
  validationDataPath?: string;
  epochs?: number;
  learningRateMultiplier?: number;
  displayName: string;
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

export interface CreatedTuningJobResult {
  job: TuningJob;
  region: string;
  sourceModel: string;
  trainingDatasetUri: string;
  validationDatasetUri?: string;
}

export interface VertexModelPreferencePatch {
  scope: VertexTuningScope;
  slot: VertexTuningSlot;
  ownerId?: string;
  modelPreferences: {
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
  trainingDatasetUri: string;
  validationDatasetUri?: string;
  region: string;
  sourceModel: string;
}

async function getAccessToken(providedToken?: string): Promise<string> {
  if (providedToken) return providedToken;
  if (process.env.GOOGLE_ACCESS_TOKEN?.trim()) {
    return process.env.GOOGLE_ACCESS_TOKEN.trim();
  }

  try {
    const { stdout } = await execFileAsync("gcloud", ["auth", "print-access-token"]);
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // Fall through to the explicit error below.
  }

  throw new Error(
    "No Google access token available. Set GOOGLE_ACCESS_TOKEN or configure gcloud auth.",
  );
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
    throw new Error(`GCS upload failed: ${response.status} ${await response.text()}`);
  }

  return `gs://${bucket}/${objectName}`;
}

export async function createTuningJob(config: VertexTuningConfig): Promise<CreatedTuningJobResult> {
  const region = config.region ?? "us-central1";
  const accessToken = await getAccessToken(config.accessToken);
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

  const modelMap: Record<string, string> = {
    "gemini-2.5-flash-lite": "gemini-2.5-flash-lite-preview-06-17",
    "gemini-2.5-flash": "gemini-2.5-flash-preview-04-17",
  };
  const sourceModel = `publishers/google/models/${modelMap[config.baseModel] ?? config.baseModel}`;

  const response = await fetch(
    `https://${region}-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/${region}/tuningJobs`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        baseModel: sourceModel,
        supervisedTuningSpec: {
          trainingDatasetUri: trainingGcsUri,
          ...(validationGcsUri ? { validationDatasetUri: validationGcsUri } : {}),
          hyperParameters: {
            epochCount: config.epochs ?? 3,
            learningRateMultiplier: config.learningRateMultiplier ?? 1,
          },
        },
        tunedModelDisplayName: config.displayName,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Vertex AI tuning job creation failed: ${response.status} ${await response.text()}`,
    );
  }

  const job = (await response.json()) as TuningJob;

  return {
    job,
    region,
    sourceModel,
    trainingDatasetUri: trainingGcsUri,
    validationDatasetUri: validationGcsUri,
  };
}

export async function listTuningJobs(
  projectId: string,
  region = "us-central1",
  accessToken?: string,
): Promise<TuningJob[]> {
  const token = await getAccessToken(accessToken);
  const response = await fetch(
    `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/tuningJobs`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to list tuning jobs: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { tuningJobs?: TuningJob[] };
  return data.tuningJobs ?? [];
}

export async function getTuningJobStatus(
  jobName: string,
  accessToken?: string,
): Promise<TuningJob> {
  const token = await getAccessToken(accessToken);
  const response = await fetch(`https://aiplatform.googleapis.com/v1/${jobName}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to get tuning job status: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as TuningJob;
}

export async function orchestrateVertexTuning(
  config: VertexTuningOrchestrationConfig,
): Promise<VertexTuningOrchestrationResult> {
  const slot = config.slot ?? "should_respond";
  const scope = config.scope ?? "global";
  const createdJob = await createTuningJob({
    ...config,
    baseModel: normalizeVertexBaseModel(config.baseModel, slot),
  });
  const job = createdJob.job;

  const recommendedModelId =
    job.tunedModelEndpointName?.trim() || job.tunedModelDisplayName?.trim() || config.displayName;

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
    trainingDatasetUri: createdJob.trainingDatasetUri,
    validationDatasetUri: createdJob.validationDatasetUri,
    region: createdJob.region,
    sourceModel: createdJob.sourceModel,
  };
}
