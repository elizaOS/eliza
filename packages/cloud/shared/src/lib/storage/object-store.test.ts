import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  deleteObject,
  headObject,
  ObjectStorageLifecycleError,
  type ObjectStorageLifecycleErrorCode,
} from "./object-store";
import { type RuntimeR2Bucket, setRuntimeR2Bucket } from "./r2-runtime-binding";
import { resetObjectStorageClientForTests } from "./s3-compatible-client";

const STORAGE_ENV_KEYS = [
  "STORAGE_PROVIDER",
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_FORCE_PATH_STYLE",
  "STORAGE_HEAVY_PAYLOADS_BUCKET",
  "STORAGE_BLOB_DEFAULT_BUCKET",
  "STORAGE_TRAJECTORIES_BUCKET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_HEAVY_PAYLOADS_BUCKET",
  "R2_BLOB_DEFAULT_BUCKET",
  "R2_TRAJECTORIES_BUCKET",
] as const;

const ORIGINAL_STORAGE_ENV = new Map(
  STORAGE_ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

interface StoredTestObject {
  size: number;
  etag: string;
  version: string;
  sha256: string;
}

interface S3Call {
  method: string;
  bucket: string;
  key: string;
  versionId: string | null;
}

const s3Objects = new Map<string, StoredTestObject>();
const s3Versions = new Map<string, Map<string, StoredTestObject>>();
const s3ReplacementBeforeDelete = new Map<string, StoredTestObject>();
const s3Calls: S3Call[] = [];
let s3Server: ReturnType<typeof Bun.serve>;
let slowDeleteAborted = false;

function clearStorageEnv(): void {
  for (const key of STORAGE_ENV_KEYS) delete process.env[key];
}

function restoreStorageEnv(): void {
  clearStorageEnv();
  for (const [key, value] of ORIGINAL_STORAGE_ENV) {
    if (value !== undefined) process.env[key] = value;
  }
}

function configureS3(): void {
  process.env.STORAGE_PROVIDER = "s3";
  process.env.STORAGE_ENDPOINT = `http://127.0.0.1:${s3Server.port}`;
  process.env.STORAGE_REGION = "test-region";
  process.env.STORAGE_ACCESS_KEY_ID = "object-lifecycle-test";
  process.env.STORAGE_SECRET_ACCESS_KEY = "object-lifecycle-test-secret";
  process.env.STORAGE_FORCE_PATH_STYLE = "1";
  process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "backup-catalog-test";
  resetObjectStorageClientForTests();
}

function parseS3Path(request: Request): Pick<S3Call, "bucket" | "key" | "versionId"> {
  const url = new URL(request.url);
  const path = url.pathname.slice(1);
  const separator = path.indexOf("/");
  if (separator < 0) {
    return {
      bucket: decodeURIComponent(path),
      key: "",
      versionId: url.searchParams.get("versionId"),
    };
  }
  return {
    bucket: decodeURIComponent(path.slice(0, separator)),
    key: decodeURIComponent(path.slice(separator + 1)),
    versionId: url.searchParams.get("versionId"),
  };
}

function arrayBufferOf(...bytes: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function setS3Object(key: string, object: StoredTestObject): void {
  s3Objects.set(key, object);
  const versions = s3Versions.get(key) ?? new Map<string, StoredTestObject>();
  versions.set(object.version, object);
  s3Versions.set(key, versions);
}

async function expectLifecycleError(
  promise: Promise<unknown>,
  code: ObjectStorageLifecycleErrorCode,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected lifecycle error ${code}`);
  } catch (error) {
    if (!(error instanceof ObjectStorageLifecycleError)) throw error;
    expect(error.code).toBe(code);
  }
}

beforeAll(() => {
  s3Server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { bucket, key, versionId } = parseS3Path(request);
      s3Calls.push({ method: request.method, bucket, key, versionId });
      if (request.method === "HEAD") {
        if (key === "forbidden") {
          return new Response(null, {
            status: 403,
            headers: { "x-amz-request-id": "forbidden-request" },
          });
        }
        const object = versionId
          ? (s3Versions.get(key)?.get(versionId) ?? null)
          : (s3Objects.get(key) ?? null);
        if (!object) {
          return new Response(null, {
            status: 404,
            headers: { "x-amz-request-id": "missing-request" },
          });
        }
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(object.size),
            etag: `"${object.etag}"`,
            "x-amz-checksum-sha256": object.sha256,
            "x-amz-request-id": "head-request",
            "x-amz-version-id": object.version,
          },
        });
      }
      if (request.method === "DELETE") {
        if (key === "slow-delete") {
          return new Promise<Response>((resolve) => {
            let settled = false;
            const finish = (response: Response) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(response);
            };
            const timer = setTimeout(() => finish(new Response(null, { status: 504 })), 2_000);
            request.signal.addEventListener(
              "abort",
              () => {
                slowDeleteAborted = true;
                finish(new Response(null, { status: 499 }));
              },
              { once: true },
            );
          });
        }
        const replacement = s3ReplacementBeforeDelete.get(key);
        if (replacement) {
          s3ReplacementBeforeDelete.delete(key);
          setS3Object(key, replacement);
        }
        const ifMatch = request.headers.get("if-match")?.replace(/^"|"$/g, "") ?? null;
        if (ifMatch && s3Objects.get(key)?.etag !== ifMatch) {
          return new Response("<Error><Code>PreconditionFailed</Code></Error>", {
            status: 412,
            headers: { "content-type": "application/xml" },
          });
        }
        if (versionId) {
          s3Versions.get(key)?.delete(versionId);
          if (s3Objects.get(key)?.version === versionId) s3Objects.delete(key);
        } else {
          s3Objects.delete(key);
        }
        return new Response(null, {
          status: 204,
          headers: { "x-amz-request-id": "delete-request" },
        });
      }
      return new Response(null, { status: 405 });
    },
  });
});

beforeEach(() => {
  setRuntimeR2Bucket(null);
  resetObjectStorageClientForTests();
  clearStorageEnv();
  s3Objects.clear();
  s3Versions.clear();
  s3ReplacementBeforeDelete.clear();
  s3Calls.length = 0;
  slowDeleteAborted = false;
});

afterEach(() => {
  setRuntimeR2Bucket(null);
  resetObjectStorageClientForTests();
  clearStorageEnv();
});

afterAll(() => {
  s3Server.stop(true);
  restoreStorageEnv();
  resetObjectStorageClientForTests();
});

describe("Worker R2 exact-key lifecycle", () => {
  test("returns privacy-safe checksum/size receipts and confirms exact-key deletion", async () => {
    const key = "agent-sandbox-backups/org-a/2026-08-15/backup-a/state_data.json";
    const objects = new Map<string, StoredTestObject>([
      [key, { size: 321, etag: "runtime-etag", version: "runtime-v1", sha256: "unused" }],
    ]);
    const headCalls: string[] = [];
    const deleteCalls: string[] = [];
    const bucket: RuntimeR2Bucket = {
      async head(exactKey) {
        headCalls.push(exactKey);
        const object = objects.get(exactKey);
        if (!object) return null;
        return {
          size: object.size,
          etag: object.etag,
          version: object.version,
          checksums: { sha256: arrayBufferOf(1, 2, 3) },
        };
      },
      async get() {
        return null;
      },
      async put() {
        return {};
      },
      async delete(exactKey) {
        deleteCalls.push(exactKey);
        objects.delete(exactKey);
      },
    };
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-backups";
    setRuntimeR2Bucket(bucket);

    const observed = await headObject(key);
    expect(observed.status).toBe("present");
    if (observed.status !== "present") throw new Error("Expected a present object");
    expect(observed.locator).toMatchObject({
      transport: "worker-r2-binding",
      provider: "r2",
      bucket: "runtime-backups",
      region: "auto",
      version: "runtime-v1",
      versionSource: "provider",
    });
    expect(observed.metadata).toEqual({
      sizeBytes: 321,
      checksum: { algorithm: "sha256", encoding: "base64", value: "AQID" },
    });
    expect(JSON.stringify(observed)).not.toContain(key);
    expect(JSON.stringify(observed)).not.toContain("runtime-backups");
    expect(JSON.stringify(observed)).not.toContain('"region"');

    const receipt = await deleteObject({ key, locator: observed.locator });
    expect(receipt).toMatchObject({
      status: "deleted",
      verifiedAbsent: true,
      providerRequestId: null,
      metadata: observed.metadata,
    });
    expect(JSON.stringify(receipt)).not.toContain(key);
    expect(JSON.stringify(receipt)).not.toContain("runtime-backups");
    expect(headCalls).toEqual([key, key, key]);
    expect(deleteCalls).toEqual([key]);
  });

  test("treats absence as idempotent without issuing DELETE", async () => {
    const key = "agent-sandbox-backups/missing/state_data.json";
    const deleteCalls: string[] = [];
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-backups";
    setRuntimeR2Bucket({
      async head() {
        return null;
      },
      async get() {
        return null;
      },
      async put() {
        return {};
      },
      async delete(exactKey) {
        deleteCalls.push(exactKey);
      },
    });

    const observed = await headObject(key);
    expect(observed.status).toBe("absent");
    const receipt = await deleteObject({ key, locator: observed.locator });
    expect(receipt).toEqual({
      status: "already-absent",
      locator: observed.locator,
      metadata: null,
      providerRequestId: null,
      verifiedAbsent: true,
    });
    expect(deleteCalls).toEqual([]);
  });

  test("refuses a repointed bucket and a changed object generation", async () => {
    const key = "agent-sandbox-backups/immutable/state_data.json";
    let stored = { size: 10, etag: "etag-v1", version: "v1", sha256: "unused" };
    let deleteCount = 0;
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "bucket-a";
    setRuntimeR2Bucket({
      async head() {
        return {
          size: stored.size,
          etag: stored.etag,
          version: stored.version,
          checksums: { md5: arrayBufferOf(4, 5, 6) },
        };
      },
      async get() {
        return null;
      },
      async put() {
        return {};
      },
      async delete() {
        deleteCount += 1;
      },
    });

    const observed = await headObject(key);
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "bucket-b";
    await expectLifecycleError(
      deleteObject({ key, locator: observed.locator }),
      "OBJECT_STORAGE_LOCATOR_MISMATCH",
    );

    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "bucket-a";
    stored = { ...stored, etag: "etag-v2", version: "v2" };
    await expectLifecycleError(
      deleteObject({ key, locator: observed.locator }),
      "OBJECT_STORAGE_VERSION_MISMATCH",
    );
    expect(deleteCount).toBe(0);
  });

  test("a retry converges when DELETE succeeded but confirmation HEAD failed", async () => {
    const key = "agent-sandbox-backups/retry/state_data.json";
    let present = true;
    let deleteCount = 0;
    let failConfirmation = true;
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-backups";
    setRuntimeR2Bucket({
      async head() {
        if (!present && failConfirmation) {
          failConfirmation = false;
          throw new Error("temporary HEAD transport failure");
        }
        return present ? { size: 7, etag: "retry-etag", version: "retry-v1", checksums: {} } : null;
      },
      async get() {
        return null;
      },
      async put() {
        return {};
      },
      async delete() {
        deleteCount += 1;
        present = false;
      },
    });

    const observed = await headObject(key);
    expect(observed.status).toBe("present");
    await expect(deleteObject({ key, locator: observed.locator })).rejects.toThrow(
      "temporary HEAD transport failure",
    );
    const retried = await deleteObject({ key, locator: observed.locator });
    expect(retried.status).toBe("already-absent");
    expect(retried.verifiedAbsent).toBe(true);
    expect(retried.locator).toBe(observed.locator);
    expect(retried.locator.version).toBe("retry-v1");
    expect(deleteCount).toBe(1);
  });

  test("never certifies absence when an immutable key is concurrently overwritten", async () => {
    const key = "agent-sandbox-backups/overwrite-forbidden/state_data.json";
    let stored: StoredTestObject | null = {
      size: 7,
      etag: "immutable-v1",
      version: "immutable-v1",
      sha256: "unused",
    };
    let deleteCount = 0;
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-backups";
    setRuntimeR2Bucket({
      async head() {
        if (!stored) return null;
        return {
          size: stored.size,
          etag: stored.etag,
          version: stored.version,
          checksums: {},
        };
      },
      async get() {
        return null;
      },
      async put() {
        return {};
      },
      async delete() {
        deleteCount += 1;
        // Simulate an illegal writer reusing the key between DELETE and the
        // confirmation HEAD. The primitive must not issue a success receipt.
        stored = {
          size: 8,
          etag: "immutable-v2",
          version: "immutable-v2",
          sha256: "unused",
        };
      },
    });

    const observed = await headObject(key);
    await expectLifecycleError(
      deleteObject({ key, locator: observed.locator }),
      "OBJECT_STORAGE_DELETE_UNCONFIRMED",
    );
    await expectLifecycleError(
      deleteObject({ key, locator: observed.locator }),
      "OBJECT_STORAGE_VERSION_MISMATCH",
    );
    expect(deleteCount).toBe(1);
  });
});

describe("S3-compatible exact-key lifecycle", () => {
  test("uses HEAD/DELETE for one exact key and returns provider locator/receipt", async () => {
    configureS3();
    const key = "agent-sandbox-backups/org-s3/2026-08-15/backup-s3/state_data.json";
    setS3Object(key, {
      size: 987,
      etag: "s3-etag",
      version: "s3-version-1",
      sha256: "c2hhMjU2LXRlc3Q=",
    });

    const observed = await headObject(key);
    expect(observed.status).toBe("present");
    if (observed.status !== "present") throw new Error("Expected a present S3 object");
    expect(observed.locator).toMatchObject({
      transport: "s3-compatible",
      provider: "s3",
      bucket: "backup-catalog-test",
      region: "test-region",
      version: "s3-version-1",
      versionSource: "provider",
    });
    expect(observed.metadata).toEqual({
      sizeBytes: 987,
      checksum: { algorithm: "sha256", encoding: "base64", value: "c2hhMjU2LXRlc3Q=" },
    });
    expect(JSON.stringify(observed)).not.toContain("backup-catalog-test");
    expect(JSON.stringify(observed)).not.toContain("test-region");

    const receipt = await deleteObject({ key, locator: observed.locator });
    expect(receipt).toMatchObject({
      status: "deleted",
      verifiedAbsent: true,
      providerRequestId: "delete-request",
      metadata: observed.metadata,
    });
    expect(JSON.stringify(receipt)).not.toContain(key);
    expect(JSON.stringify(receipt)).not.toContain("backup-catalog-test");
    expect(JSON.stringify(receipt)).not.toContain("test-region");
    expect(s3Calls).toEqual([
      { method: "HEAD", bucket: "backup-catalog-test", key, versionId: null },
      { method: "HEAD", bucket: "backup-catalog-test", key, versionId: "s3-version-1" },
      {
        method: "DELETE",
        bucket: "backup-catalog-test",
        key,
        versionId: "s3-version-1",
      },
      { method: "HEAD", bucket: "backup-catalog-test", key, versionId: "s3-version-1" },
    ]);
  });

  test("propagates caller abort through the S3 delete command and skips the post-delete HEAD", async () => {
    configureS3();
    const key = "slow-delete";
    setS3Object(key, {
      size: 42,
      etag: "slow-etag",
      version: "slow-version",
      sha256: "c2xvdy1zaGEyNTY=",
    });
    const observed = await headObject(key);
    if (observed.status !== "present") throw new Error("Expected a present S3 object");
    s3Calls.length = 0;
    const controller = new AbortController();
    const deletion = deleteObject(
      { key, locator: observed.locator },
      { signal: controller.signal, deadline: new Date(Date.now() + 60_000) },
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (s3Calls.some((call) => call.method === "DELETE")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(s3Calls.some((call) => call.method === "DELETE")).toBe(true);
    controller.abort(new Error("shutdown"));
    await expectLifecycleError(deletion, "OBJECT_STORAGE_DELETE_ABORTED");
    for (let attempt = 0; attempt < 100 && !slowDeleteAborted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(slowDeleteAborted).toBe(true);
    expect(s3Calls.filter((call) => call.method === "HEAD")).toHaveLength(1);
  });

  test("deletes the catalogued S3 version even when the current key is hidden by a delete marker", async () => {
    configureS3();
    const key = "agent-sandbox-backups/org-s3/hidden-current/chunk";
    setS3Object(key, {
      size: 42,
      etag: "old-etag",
      version: "old-version",
      sha256: "b2xkLXNoYTI1Ng==",
    });
    const observed = await headObject(key);
    expect(observed.status).toBe("present");
    if (observed.status !== "present") throw new Error("Expected a versioned S3 object");

    // A current-key HEAD now returns 404, while the catalogued immutable
    // version remains addressable by VersionId behind the delete marker.
    s3Objects.delete(key);
    const receipt = await deleteObject({ key, locator: observed.locator });

    expect(receipt).toMatchObject({ status: "deleted", verifiedAbsent: true });
    expect(s3Versions.get(key)?.has("old-version")).toBe(false);
    expect(s3Calls.slice(-3)).toEqual([
      { method: "HEAD", bucket: "backup-catalog-test", key, versionId: "old-version" },
      { method: "DELETE", bucket: "backup-catalog-test", key, versionId: "old-version" },
      { method: "HEAD", bucket: "backup-catalog-test", key, versionId: "old-version" },
    ]);
  });

  test("uses If-Match so an unversioned S3 replacement cannot win the HEAD-to-DELETE race", async () => {
    configureS3();
    const key = "agent-sandbox-backups/org-s3/unversioned-race/chunk";
    setS3Object(key, {
      size: 42,
      etag: "etag-old",
      version: "",
      sha256: "b2xkLXNoYTI1Ng==",
    });
    const observed = await headObject(key);
    expect(observed.status).toBe("present");
    if (observed.status !== "present") throw new Error("Expected an unversioned S3 object");
    expect(observed.locator).toMatchObject({ version: "etag-old", versionSource: "etag" });

    s3ReplacementBeforeDelete.set(key, {
      size: 43,
      etag: "etag-new",
      version: "",
      sha256: "bmV3LXNoYTI1Ng==",
    });
    await expectLifecycleError(
      deleteObject({ key, locator: observed.locator }),
      "OBJECT_STORAGE_VERSION_MISMATCH",
    );
    expect(s3Objects.get(key)?.etag).toBe("etag-new");
  });

  test("maps only object-not-found to idempotent absence", async () => {
    configureS3();
    const key = "agent-sandbox-backups/s3-missing/state_data.json";

    const observed = await headObject(key);
    expect(observed.status).toBe("absent");
    const receipt = await deleteObject({ key, locator: observed.locator });
    expect(receipt.status).toBe("already-absent");
    expect(s3Calls.map(({ method }) => method)).toEqual(["HEAD", "HEAD"]);

    await expect(headObject("forbidden")).rejects.toMatchObject({
      $metadata: { httpStatusCode: 403 },
    });
  });
});
