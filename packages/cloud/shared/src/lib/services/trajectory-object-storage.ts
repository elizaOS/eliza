/**
 * Object storage for LLM trajectory prompt/response bodies.
 *
 * New payloads go ONLY to a dedicated private store: the `TRAJECTORY_BLOB`
 * Worker R2 binding, or (outside Workers) an S3-compatible bucket named by
 * `STORAGE_TRAJECTORIES_BUCKET` / `R2_TRAJECTORIES_BUCKET`. The general `BLOB`
 * bucket has a public host and is never written. Without a private store,
 * callers keep the (encrypted) bodies inline in Postgres.
 *
 * Rows written before this split point at the general bucket
 * (`trajectory_payload_storage = 'r2'`); those payloads remain readable and
 * deletable here so the retention purge can remove them.
 *
 * Keys are `{organizationId}/{yyyy-mm-dd}/{trajectoryId}.json`.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getCloudAwareEnv, getCloudBinding } from "../runtime/cloud-bindings";
import { getRuntimeR2Bucket, type RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { getObjectStorageClient, objectStorageConfigured } from "../storage/s3-compatible-client";

/** Where a row's prompt/response bodies live. */
export type TrajectoryPayloadStorage = "inline" | "private_object" | "r2";

/** Encoded (encrypted, or legacy plaintext) bodies as persisted. */
export interface TrajectoryInlinePayload {
  system_prompt: string | null;
  user_prompt: string | null;
  response_text: string | null;
}

/** A row points at an object store this deployment cannot reach. */
export class TrajectoryStorageUnavailableError extends Error {
  readonly code = "TRAJECTORY_STORAGE_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "TrajectoryStorageUnavailableError";
  }
}

export const TRAJECTORY_PRIVATE_R2_BINDING = "TRAJECTORY_BLOB";

type TrajectoryStore =
  | { kind: "r2"; bucket: RuntimeR2Bucket }
  | {
      kind: "s3";
      bucket: string;
      client: NonNullable<ReturnType<typeof getObjectStorageClient>>;
    };

function s3Store(bucket: string | undefined | null): TrajectoryStore | null {
  if (!bucket || !objectStorageConfigured()) return null;
  const client = getObjectStorageClient();
  return client ? { kind: "s3", bucket, client } : null;
}

/** The dedicated private trajectory store, or null when none is configured. */
function privateStore(): TrajectoryStore | null {
  const binding = getCloudBinding<RuntimeR2Bucket>(TRAJECTORY_PRIVATE_R2_BINDING);
  if (binding) return { kind: "r2", bucket: binding };
  const env = getCloudAwareEnv();
  return s3Store(env.STORAGE_TRAJECTORIES_BUCKET ?? env.R2_TRAJECTORIES_BUCKET);
}

/** Store used by rows written before the private split (read/delete only). */
function legacyStore(): TrajectoryStore | null {
  const runtimeBucket = getRuntimeR2Bucket();
  if (runtimeBucket) return { kind: "r2", bucket: runtimeBucket };
  const env = getCloudAwareEnv();
  return s3Store(
    env.STORAGE_TRAJECTORIES_BUCKET ??
      env.STORAGE_BLOB_DEFAULT_BUCKET ??
      env.R2_TRAJECTORIES_BUCKET ??
      env.R2_BLOB_DEFAULT_BUCKET,
  );
}

function storeFor(storage: Exclude<TrajectoryPayloadStorage, "inline">): TrajectoryStore {
  const store = storage === "private_object" ? privateStore() : legacyStore();
  if (!store) {
    throw new TrajectoryStorageUnavailableError(
      storage === "private_object"
        ? `Trajectory payload is in the private store but neither the ${TRAJECTORY_PRIVATE_R2_BINDING} binding nor STORAGE_TRAJECTORIES_BUCKET is configured`
        : "Legacy trajectory payload is in the general blob store but no blob storage is configured",
    );
  }
  return store;
}

/** Whether new payloads can be offloaded to a dedicated private store. */
export function privateTrajectoryStoreConfigured(): boolean {
  return privateStore() !== null;
}

export async function putTrajectoryPayload(params: {
  organizationId: string;
  trajectoryId: string;
  createdAt: Date;
  body: TrajectoryInlinePayload;
}): Promise<string> {
  const store = privateStore();
  if (!store) {
    throw new TrajectoryStorageUnavailableError(
      "No private trajectory store is configured; keep the payload inline",
    );
  }
  const day = params.createdAt.toISOString().slice(0, 10);
  const key = `${params.organizationId}/${day}/${params.trajectoryId}.json`;
  const body = JSON.stringify(params.body);
  const contentType = "application/json; charset=utf-8";

  if (store.kind === "r2") {
    await store.bucket.put(key, body, { httpMetadata: { contentType } });
    return key;
  }
  await store.client.send(
    new PutObjectCommand({ Bucket: store.bucket, Key: key, Body: body, ContentType: contentType }),
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

export async function getTrajectoryPayload(
  storage: Exclude<TrajectoryPayloadStorage, "inline">,
  key: string,
): Promise<TrajectoryInlinePayload | null> {
  const store = storeFor(storage);
  if (store.kind === "r2") {
    const object = await store.bucket.get(key);
    if (!object) return null;
    return parseTrajectoryPayloadJson(await object.text());
  }
  const out = await store.client.send(new GetObjectCommand({ Bucket: store.bucket, Key: key }));
  const raw = await out.Body?.transformToString();
  if (!raw) return null;
  return parseTrajectoryPayloadJson(raw);
}

/** Delete one payload object. Deleting an absent key succeeds (idempotent). */
export async function deleteTrajectoryPayload(
  storage: Exclude<TrajectoryPayloadStorage, "inline">,
  key: string,
): Promise<void> {
  const store = storeFor(storage);
  if (store.kind === "r2") {
    await store.bucket.delete(key);
    return;
  }
  await store.client.send(new DeleteObjectCommand({ Bucket: store.bucket, Key: key }));
}

function organizationPrefix(organizationId: string): string {
  if (!organizationId || organizationId.includes("/")) {
    throw new TrajectoryStorageUnavailableError(
      "Refusing to enumerate trajectory payloads without a single-segment organization id",
    );
  }
  return `${organizationId}/`;
}

/**
 * Every payload key under `{organizationId}/` in the private trajectory store,
 * found by prefix listing (so objects whose row is already gone are included).
 * Returns null when no private store is configured.
 */
export async function listPrivateTrajectoryObjectKeys(
  organizationId: string,
): Promise<string[] | null> {
  const prefix = organizationPrefix(organizationId);
  const store = privateStore();
  if (!store) return null;
  const keys: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  if (store.kind === "r2") {
    if (!store.bucket.list) {
      throw new TrajectoryStorageUnavailableError(
        `The ${TRAJECTORY_PRIVATE_R2_BINDING} binding cannot list objects`,
      );
    }
    for (;;) {
      const page = await store.bucket.list({ prefix, cursor, limit: 1_000 });
      for (const object of page.objects) {
        if (object.key?.startsWith(prefix)) keys.push(object.key);
      }
      if (!page.truncated) break;
      if (!page.cursor || seenCursors.has(page.cursor)) {
        throw new TrajectoryStorageUnavailableError("Trajectory store listing did not advance");
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    return keys.sort();
  }

  for (;;) {
    const page = await store.client.send(
      new ListObjectsV2Command({ Bucket: store.bucket, Prefix: prefix, ContinuationToken: cursor }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key?.startsWith(prefix)) keys.push(object.Key);
    }
    if (!page.IsTruncated) break;
    const next = page.NextContinuationToken;
    if (!next || seenCursors.has(next)) {
      throw new TrajectoryStorageUnavailableError("Trajectory store listing did not advance");
    }
    seenCursors.add(next);
    cursor = next;
  }
  return keys.sort();
}
