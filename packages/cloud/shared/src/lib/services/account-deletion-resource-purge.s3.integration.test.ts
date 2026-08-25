/** Proves account-deletion object purging against a disposable S3-compatible server. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  RuntimeR2Bucket,
  RuntimeR2ListOptions,
  RuntimeR2ObjectMetadata,
  RuntimeR2PutOptions,
} from "../storage/r2-runtime-binding";
import { purgeOrganizationObjectStorage } from "./account-deletion-resource-purge";

const ENDPOINT = process.env.ELIZA_ACCOUNT_DELETION_S3_ENDPOINT ?? "";
const BUCKET = "eliza-account-deletion-test";
const ACCESS_KEY_ID = "eliza_local_test";
const SECRET_ACCESS_KEY = "eliza_local_disposable_only";
const ORGANIZATION_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_ORGANIZATION_ID = "88888888-8888-4888-8888-888888888888";

function isExplicitDisposableTarget(): boolean {
  if (process.env.ELIZA_ACCOUNT_DELETION_REAL_S3_TEST !== "1") return false;
  try {
    const endpoint = new URL(ENDPOINT);
    return (
      endpoint.protocol === "http:" &&
      (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost") &&
      endpoint.port === "59000"
    );
  } catch {
    return false;
  }
}

const enabled = isExplicitDisposableTarget();
const client = new S3Client({
  endpoint: ENDPOINT || "http://127.0.0.1:59000",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
});

function metadataFromHead(key: string, head: Awaited<ReturnType<typeof headObject>>) {
  const customMetadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(head.Metadata ?? {})) {
    if (value !== undefined) {
      customMetadata[name === "organizationid" ? "organizationId" : name] = value;
    }
  }
  return {
    key,
    size: head.ContentLength ?? 0,
    etag: head.ETag ?? "",
    uploaded: head.LastModified,
    customMetadata,
    httpMetadata: { contentType: head.ContentType },
  } satisfies RuntimeR2ObjectMetadata;
}

function headObject(key: string) {
  return client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
}

const bucket: RuntimeR2Bucket = {
  async head(key) {
    try {
      return metadataFromHead(key, await headObject(key));
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        return null;
      }
      throw error;
    }
  },
  async get(key) {
    const result = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!result.Body) return null;
    const bytes = await result.Body.transformToByteArray();
    return {
      size: result.ContentLength,
      etag: result.ETag,
      customMetadata: result.Metadata,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  },
  async put(key, value, options?: RuntimeR2PutOptions) {
    const body =
      value === null || typeof value === "string" || value instanceof Blob
        ? value
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : new Uint8Array(value);
    return client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: options?.httpMetadata?.contentType,
        Metadata: options?.customMetadata,
      }),
    );
  },
  delete(key) {
    return client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  },
  async list(options?: RuntimeR2ListOptions) {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: options?.prefix,
        ContinuationToken: options?.cursor,
        MaxKeys: options?.limit,
        Delimiter: options?.delimiter,
      }),
    );
    const objects = await Promise.all(
      (result.Contents ?? []).flatMap((object) =>
        object.Key
          ? [headObject(object.Key).then((head) => metadataFromHead(object.Key as string, head))]
          : [],
      ),
    );
    return {
      objects,
      truncated: result.IsTruncated ?? false,
      cursor: result.NextContinuationToken,
    };
  },
};

const fixtureKeys = [
  `backups/${ORGANIZATION_ID}/agent.tar`,
  "avatars/metadata-owned.webp",
  `backups/${OTHER_ORGANIZATION_ID}/keep.tar`,
  `backups/prefix-${ORGANIZATION_ID}-suffix/keep.tar`,
];

describe.skipIf(!enabled)("account deletion against disposable S3-compatible storage", () => {
  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch((error) => {
      const name = (error as { name?: string }).name;
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw error;
    });
    await Promise.all(fixtureKeys.map((key) => bucket.delete(key)));
    await bucket.put(fixtureKeys[0], "owned-by-path");
    await bucket.put(fixtureKeys[1], "owned-by-metadata", {
      customMetadata: { organizationId: ORGANIZATION_ID },
    });
    await bucket.put(fixtureKeys[2], "other-tenant");
    await bucket.put(fixtureKeys[3], "substring-only");
  });

  afterAll(async () => {
    await Promise.all(fixtureKeys.map((key) => bucket.delete(key)));
    client.destroy();
  });

  test("deletes only exact path-segment or metadata ownership and preserves another tenant", async () => {
    await expect(purgeOrganizationObjectStorage(bucket, ORGANIZATION_ID)).resolves.toBe(2);
    await expect(bucket.head?.(fixtureKeys[0])).resolves.toBeNull();
    await expect(bucket.head?.(fixtureKeys[1])).resolves.toBeNull();
    await expect(bucket.head?.(fixtureKeys[2])).resolves.not.toBeNull();
    await expect(bucket.head?.(fixtureKeys[3])).resolves.not.toBeNull();
  });
});
