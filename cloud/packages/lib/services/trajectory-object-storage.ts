/**
 * Optional object storage for LLM trajectory prompts/responses.
 * Postgres keeps metadata + metrics + pointer (`trajectory_payload_key`) when enabled.
 *
 * Object keys remain `{organizationId}/{yyyy-mm-dd}/{trajectoryId}.json`
 * for compatibility with existing objects.
 *
 * Backend selection follows packages/lib/storage/s3-compatible-client.ts (R2 in
 * production, self-hosted Supabase Storage in local dev, any S3 endpoint via
 * STORAGE_ENDPOINT). Inside Cloudflare Workers, the native R2 binding is used.
 */

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { getRuntimeR2Bucket, runtimeR2BucketConfigured } from "@/lib/storage/r2-runtime-binding";
import {
  getObjectStorageClient,
  objectStorageConfigured,
} from "@/lib/storage/s3-compatible-client";

export interface TrajectoryInlinePayload {
  system_prompt: string | null;
  user_prompt: string | null;
  response_text: string | null;
}

function trajectoryBucket(): string | null {
  const env = getCloudAwareEnv();
  return (
    env.STORAGE_TRAJECTORIES_BUCKET ??
    env.STORAGE_BLOB_DEFAULT_BUCKET ??
    env.R2_TRAJECTORIES_BUCKET ??
    env.R2_BLOB_DEFAULT_BUCKET ??
    null
  );
}

function trajectoryStorageConfigured(): boolean {
  if (runtimeR2BucketConfigured()) return true;
  return objectStorageConfigured() && Boolean(trajectoryBucket());
}

/**
 * When `LLM_TRAJECTORY_STORAGE` is unset, offload if the Worker binding or S3 credentials exist.
 * Set `LLM_TRAJECTORY_STORAGE=inline` to force Postgres-only rows.
 * Set `LLM_TRAJECTORY_STORAGE=r2` to require the object store.
 */
export function shouldUseR2ForTrajectoryPayloads(): boolean {
  const mode = getCloudAwareEnv().LLM_TRAJECTORY_STORAGE;
  if (mode === "inline") return false;
  if (mode === "r2") {
    if (!trajectoryStorageConfigured()) {
      throw new Error(
        "LLM_TRAJECTORY_STORAGE=r2 but no Worker R2 binding or S3-compatible storage is configured",
      );
    }
    return true;
  }
  return trajectoryStorageConfigured();
}

export async function putTrajectoryPayload(params: {
  organizationId: string;
  trajectoryId: string;
  createdAt: Date;
  body: TrajectoryInlinePayload;
}): Promise<string> {
  const day = params.createdAt.toISOString().slice(0, 10);
  const key = `${params.organizationId}/${day}/${params.trajectoryId}.json`;
  const body = JSON.stringify(params.body);

  const runtimeBucket = getRuntimeR2Bucket();
  if (runtimeBucket) {
    await runtimeBucket.put(key, body, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return key;
  }

  const bucket = trajectoryBucket();
  const client = getObjectStorageClient();
  if (!bucket || !client) {
    throw new Error("Trajectory object storage requested but client or bucket is not configured");
  }

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/json; charset=utf-8",
    }),
  );
  return key;
}

interface TrajectoryPayloadJsonShape {
  system_prompt?: string | null;
  user_prompt?: string | null;
  response_text?: string | null;
}

function parseTrajectoryPayloadJson(raw: string): TrajectoryInlinePayload {
  const data = JSON.parse(raw) as TrajectoryPayloadJsonShape;
  return {
    system_prompt: data.system_prompt ?? null,
    user_prompt: data.user_prompt ?? null,
    response_text: data.response_text ?? null,
  };
}

export async function getTrajectoryPayload(key: string): Promise<TrajectoryInlinePayload | null> {
  const runtimeBucket = getRuntimeR2Bucket();
  if (runtimeBucket) {
    const object = await runtimeBucket.get(key);
    if (!object) return null;
    return parseTrajectoryPayloadJson(await object.text());
  }

  const bucket = trajectoryBucket();
  const client = getObjectStorageClient();
  if (!bucket || !client) return null;
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const raw = await out.Body?.transformToString();
  if (!raw) return null;
  return parseTrajectoryPayloadJson(raw);
}
