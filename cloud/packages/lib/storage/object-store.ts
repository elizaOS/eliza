import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import type { ObjectNamespace } from "@/lib/storage/object-namespace";
import { getRuntimeR2Bucket, runtimeR2BucketConfigured } from "@/lib/storage/r2-runtime-binding";
import {
  getObjectStorageClient,
  objectStorageConfigured,
} from "@/lib/storage/s3-compatible-client";

export type ObjectStorageMode = "inline" | "r2";

export interface OffloadedField<T> {
  value: T | null;
  storage: ObjectStorageMode;
  key: string | null;
}

function heavyPayloadBucket(): string | null {
  const env = getCloudAwareEnv();
  return (
    env.STORAGE_HEAVY_PAYLOADS_BUCKET ??
    env.STORAGE_BLOB_DEFAULT_BUCKET ??
    env.STORAGE_TRAJECTORIES_BUCKET ??
    env.R2_HEAVY_PAYLOADS_BUCKET ??
    env.R2_BLOB_DEFAULT_BUCKET ??
    env.R2_TRAJECTORIES_BUCKET ??
    null
  );
}

function storageConfigured(): boolean {
  if (runtimeR2BucketConfigured()) return true;
  return objectStorageConfigured() && Boolean(heavyPayloadBucket());
}

export function shouldUseObjectStorage(): boolean {
  const env = getCloudAwareEnv();
  const mode = env.SQL_HEAVY_PAYLOAD_STORAGE ?? env.HEAVY_PAYLOAD_STORAGE;
  if (mode === "inline") return false;
  if (mode === "r2") {
    if (!storageConfigured()) {
      throw new Error(
        "SQL_HEAVY_PAYLOAD_STORAGE=r2 but no Worker R2 binding or S3-compatible storage is configured",
      );
    }
    return true;
  }
  return storageConfigured();
}

function minBytes(): number {
  const raw = getCloudAwareEnv().SQL_HEAVY_PAYLOAD_MIN_BYTES;
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function previewBytes(): number {
  const raw = getCloudAwareEnv().SQL_HEAVY_PAYLOAD_INLINE_PREVIEW_BYTES;
  if (!raw) return 512;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 512;
  return Math.floor(parsed);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function shouldOffload(value: string): boolean {
  return value.length > 0 && shouldUseObjectStorage() && byteLength(value) >= minBytes();
}

function preview(value: string): string {
  const limit = previewBytes();
  if (limit === 0) return "";
  if (byteLength(value) <= limit) return value;
  let output = "";
  let size = 0;
  for (const char of value) {
    const charSize = byteLength(char);
    if (size + charSize > limit) break;
    output += char;
    size += charSize;
  }
  return output;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._=-]/g, "_");
}

function objectKey(params: {
  namespace: ObjectNamespace;
  organizationId: string;
  objectId: string;
  field: string;
  createdAt: Date;
  extension: "json" | "txt";
}): string {
  const day = params.createdAt.toISOString().slice(0, 10);
  return [
    params.namespace,
    safeSegment(params.organizationId),
    day,
    safeSegment(params.objectId),
    `${safeSegment(params.field)}.${params.extension}`,
  ].join("/");
}

export async function putObjectText(params: {
  namespace: ObjectNamespace;
  organizationId: string;
  objectId: string;
  field: string;
  createdAt: Date;
  body: string;
  contentType: string;
}): Promise<string> {
  const extension = params.contentType.includes("json") ? "json" : "txt";
  const key = objectKey({ ...params, extension });

  const runtimeBucket = getRuntimeR2Bucket();
  if (runtimeBucket) {
    await runtimeBucket.put(key, params.body, {
      httpMetadata: { contentType: params.contentType },
    });
    return key;
  }

  const bucket = heavyPayloadBucket();
  const client = getObjectStorageClient();
  if (!bucket || !client) {
    throw new Error("Object storage requested but client or bucket is not configured");
  }

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: params.body,
      ContentType: params.contentType,
    }),
  );
  return key;
}

export async function getObjectText(key: string): Promise<string | null> {
  const runtimeBucket = getRuntimeR2Bucket();
  if (runtimeBucket) {
    const object = await runtimeBucket.get(key);
    return object ? await object.text() : null;
  }

  const bucket = heavyPayloadBucket();
  const client = getObjectStorageClient();
  if (!bucket || !client) return null;
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await out.Body?.transformToString()) ?? null;
}

export async function offloadTextField(params: {
  namespace: ObjectNamespace;
  organizationId: string;
  objectId: string;
  field: string;
  createdAt: Date;
  value: string | null | undefined;
  keepPreview?: boolean;
  inlineValueWhenOffloaded?: string;
}): Promise<OffloadedField<string>> {
  if (params.value == null) return { value: null, storage: "inline", key: null };
  if (!shouldOffload(params.value)) return { value: params.value, storage: "inline", key: null };

  const key = await putObjectText({
    namespace: params.namespace,
    organizationId: params.organizationId,
    objectId: params.objectId,
    field: params.field,
    createdAt: params.createdAt,
    body: params.value,
    contentType: "text/plain; charset=utf-8",
  });

  return {
    value:
      params.inlineValueWhenOffloaded ??
      (params.keepPreview === false ? "" : preview(params.value)),
    storage: "r2",
    key,
  };
}

export async function offloadJsonField<T>(params: {
  namespace: ObjectNamespace;
  organizationId: string;
  objectId: string;
  field: string;
  createdAt: Date;
  value: T | null | undefined;
  inlineValueWhenOffloaded: T | null;
}): Promise<OffloadedField<T>> {
  if (params.value == null) return { value: null, storage: "inline", key: null };
  const body = JSON.stringify(params.value);
  if (!shouldOffload(body)) return { value: params.value, storage: "inline", key: null };

  const key = await putObjectText({
    namespace: params.namespace,
    organizationId: params.organizationId,
    objectId: params.objectId,
    field: params.field,
    createdAt: params.createdAt,
    body,
    contentType: "application/json; charset=utf-8",
  });

  return {
    value: params.inlineValueWhenOffloaded,
    storage: "r2",
    key,
  };
}

export async function hydrateTextField(params: {
  storage: string;
  key: string | null;
  inlineValue: string | null;
}): Promise<string | null> {
  if (params.storage !== "r2" || !params.key) return params.inlineValue;
  return (await getObjectText(params.key)) ?? params.inlineValue;
}

export async function hydrateJsonField<T>(params: {
  storage: string;
  key: string | null;
  inlineValue: T | null;
}): Promise<T | null> {
  if (params.storage !== "r2" || !params.key) return params.inlineValue;
  const raw = await getObjectText(params.key);
  if (!raw) return params.inlineValue;
  return JSON.parse(raw) as T;
}
