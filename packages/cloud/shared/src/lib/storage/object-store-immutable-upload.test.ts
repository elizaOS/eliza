/** Verifies immutable uploads through real storage adapters with scripted R2 and local S3 transports. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  MAX_IMMUTABLE_PUT_ATTEMPTS,
  MAX_IMMUTABLE_SINGLE_PUT_BYTES,
  ObjectStorageLifecycleError,
  type ObjectStorageLifecycleErrorCode,
  putImmutableObject,
} from "./object-store";
import {
  type RuntimeR2Bucket,
  type RuntimeR2ObjectMetadata,
  setRuntimeR2Bucket,
} from "./r2-runtime-binding";
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

interface StoredS3Object {
  size: number;
  providerSha256: string;
  declaredSha256: string;
  exposeProviderChecksum?: boolean;
  etag: string;
  version: string;
}

interface S3PutBehavior {
  status: number;
  persist: boolean;
  delayMs?: number;
}

interface S3Call {
  method: string;
  key: string;
  ifNoneMatch: string | null;
  checksumSha256: string | null;
}

const s3Objects = new Map<string, StoredS3Object>();
const s3PutBehaviors = new Map<string, S3PutBehavior[]>();
const s3Calls: S3Call[] = [];
let s3Server: ReturnType<typeof Bun.serve>;

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
  process.env.STORAGE_ACCESS_KEY_ID = "immutable-upload-test";
  process.env.STORAGE_SECRET_ACCESS_KEY = "immutable-upload-test-secret";
  process.env.STORAGE_FORCE_PATH_STYLE = "1";
  process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "immutable-upload-test-bucket";
  resetObjectStorageClientForTests();
}

function parseS3Key(request: Request): string {
  const path = new URL(request.url).pathname.slice(1);
  const separator = path.indexOf("/");
  return separator < 0 ? "" : decodeURIComponent(path.slice(separator + 1));
}

function s3Error(status: number): Response {
  const code =
    status === 412
      ? "PreconditionFailed"
      : status === 429
        ? "SlowDown"
        : status === 501
          ? "NotImplemented"
          : "InternalError";
  return new Response(`<Error><Code>${code}</Code><Message>provider failure</Message></Error>`, {
    status,
    headers: {
      "content-type": "application/xml",
      "x-amz-request-id": `request-${status}`,
    },
  });
}

function storeS3Object(
  key: string,
  size: number,
  providerSha256: string,
  declaredSha256: string,
): void {
  s3Objects.set(key, {
    size,
    providerSha256,
    declaredSha256,
    etag: `etag-${providerSha256.slice(0, 12)}`,
    version: `version-${providerSha256.slice(0, 12)}`,
  });
}

function providerFailure(status: number): Error {
  return Object.assign(new Error("provider failure"), {
    $metadata: { httpStatusCode: status },
  });
}

async function expectLifecycleError(
  promise: Promise<unknown>,
  code: ObjectStorageLifecycleErrorCode,
): Promise<ObjectStorageLifecycleError> {
  try {
    await promise;
    throw new Error(`Expected lifecycle error ${code}`);
  } catch (error) {
    if (!(error instanceof ObjectStorageLifecycleError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

beforeAll(() => {
  s3Server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const key = parseS3Key(request);
      s3Calls.push({
        method: request.method,
        key,
        ifNoneMatch: request.headers.get("if-none-match"),
        checksumSha256: request.headers.get("x-amz-checksum-sha256"),
      });

      if (request.method === "HEAD") {
        const object = s3Objects.get(key);
        if (!object) {
          return new Response(null, {
            status: 404,
            headers: { "x-amz-request-id": "head-missing" },
          });
        }
        const headers: Record<string, string> = {
          "content-length": String(object.size),
          etag: `"${object.etag}"`,
          "x-amz-meta-eliza-content-sha256": object.declaredSha256,
          "x-amz-request-id": "head-present",
          "x-amz-version-id": object.version,
        };
        if (object.exposeProviderChecksum !== false) {
          headers["x-amz-checksum-sha256"] = object.providerSha256;
        }
        return new Response(null, {
          status: 200,
          headers,
        });
      }

      if (request.method === "PUT") {
        const body = await request.arrayBuffer();
        const sha256 =
          request.headers.get("x-amz-checksum-sha256") ??
          request.headers.get("x-amz-meta-eliza-content-sha256") ??
          "";
        if (request.headers.get("if-none-match") !== "*") return s3Error(501);
        if (s3Objects.has(key)) return s3Error(412);

        const behavior = s3PutBehaviors.get(key)?.shift();
        if (behavior?.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
        }
        const providerSha256 = Buffer.from(await crypto.subtle.digest("SHA-256", body)).toString(
          "base64",
        );
        if (behavior?.persist || !behavior) {
          storeS3Object(key, body.byteLength, providerSha256, sha256);
        }
        if (behavior && behavior.status !== 200) return s3Error(behavior.status);
        const stored = s3Objects.get(key);
        return new Response(null, {
          status: 200,
          headers: {
            etag: `"${stored?.etag ?? "missing"}"`,
            "x-amz-request-id": "put-created",
            "x-amz-version-id": stored?.version ?? "missing",
          },
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
  s3PutBehaviors.clear();
  s3Calls.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
  setRuntimeR2Bucket(null);
  resetObjectStorageClientForTests();
  clearStorageEnv();
});

afterAll(() => {
  s3Server.stop(true);
  restoreStorageEnv();
  resetObjectStorageClientForTests();
});

describe("Worker R2 immutable exact-key upload", () => {
  test("rejects an oversized body before touching storage", async () => {
    const key = "agent-sandbox-backups/private-org/operation-oversized/chunk-0001";
    const error = await expectLifecycleError(
      putImmutableObject({
        key,
        body: new Uint8Array(MAX_IMMUTABLE_SINGLE_PUT_BYTES + 1),
      }),
      "OBJECT_STORAGE_UPLOAD_TOO_LARGE",
    );
    expect(String(error)).not.toContain(key);
  });

  test("uploads the maximum transferred body with only one provider-attempt copy", async () => {
    const key = "agent-sandbox-backups/private-org/operation-max-transfer/chunk-0001";
    const transferred = new Uint8Array(MAX_IMMUTABLE_SINGLE_PUT_BYTES);
    transferred[0] = 0x51;
    transferred[transferred.length - 1] = 0x52;
    let providerBody: Uint8Array | undefined;
    let stored: RuntimeR2ObjectMetadata | null = null;
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-private-backups";
    setRuntimeR2Bucket({
      async head() {
        return stored;
      },
      async get() {
        return null;
      },
      async put(_exactKey, value, options) {
        if (!(value instanceof Uint8Array)) throw new Error("expected transferred byte body");
        providerBody = value;
        const checksum = options?.sha256;
        if (!(checksum instanceof ArrayBuffer)) throw new Error("expected SHA-256 bytes");
        stored = {
          size: value.byteLength,
          etag: "maximum-transfer-etag",
          version: "maximum-transfer-version",
          checksums: { sha256: checksum.slice(0) },
        };
        return stored;
      },
      async delete() {},
    });

    await expect(
      putImmutableObject({ key, body: transferred, transferBodyOwnership: true }),
    ).resolves.toMatchObject({ metadata: { sizeBytes: MAX_IMMUTABLE_SINGLE_PUT_BYTES } });
    expect(providerBody?.buffer).not.toBe(transferred.buffer);
    expect(transferred.every((byte) => byte === 0)).toBe(true);
    expect(providerBody?.every((byte) => byte === 0)).toBe(true);
  }, 30_000);

  test("replays the same HEAD receipt after response loss and refuses different bytes", async () => {
    const key = "agent-sandbox-backups/private-org/operation-a/chunk-0001";
    let stored: RuntimeR2ObjectMetadata | null = null;
    let putCalls = 0;
    let loseFirstResponse = true;
    const providerDigestInputs: ArrayBuffer[] = [];
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-private-backups";
    const bucket: RuntimeR2Bucket = {
      async head() {
        return stored;
      },
      async get() {
        return null;
      },
      async put(_exactKey, value, options) {
        putCalls += 1;
        expect(options?.onlyIf).toBeInstanceOf(Headers);
        const onlyIf = options?.onlyIf;
        if (!(onlyIf instanceof Headers)) throw new Error("expected conditional headers");
        expect(onlyIf.get("if-none-match")).toBe("*");
        if (stored) return null;
        const size = value instanceof Uint8Array ? value.byteLength : 0;
        const sha256 = options?.sha256;
        if (!(sha256 instanceof ArrayBuffer)) throw new Error("expected SHA-256 bytes");
        providerDigestInputs.push(sha256);
        stored = {
          size,
          etag: "runtime-etag-a",
          version: "runtime-version-a",
          checksums: { sha256: sha256.slice(0) },
          customMetadata: options.customMetadata,
        };
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new TypeError("response lost");
        }
        return stored;
      },
      async delete() {},
    };
    setRuntimeR2Bucket(bucket);

    const first = await putImmutableObject({ key, body: bytes(1, 2, 3, 4) });
    const replay = await putImmutableObject({ key, body: bytes(1, 2, 3, 4) });
    expect(replay).toEqual(first);
    expect(first.verifiedPresent).toBe(true);
    expect(first.metadata.sizeBytes).toBe(4);
    expect(first.metadata.checksum.algorithm).toBe("sha256");
    expect(JSON.stringify(first)).not.toContain(key);
    expect(JSON.stringify(first)).not.toContain("runtime-private-backups");

    const mismatch = await expectLifecycleError(
      putImmutableObject({ key, body: bytes(4, 3, 2, 1) }),
      "OBJECT_STORAGE_IMMUTABLE_CONFLICT",
    );
    expect(String(mismatch)).not.toContain(key);
    expect(putCalls).toBe(3);
    expect(
      providerDigestInputs.every((digest) => new Uint8Array(digest).every((byte) => byte === 0)),
    ).toBe(true);
  });

  test("retries 429/5xx within the explicit budget and stops at the cap", async () => {
    const key = "agent-sandbox-backups/private-org/operation-b/chunk-0001";
    let stored: RuntimeR2ObjectMetadata | null = null;
    let putCalls = 0;
    let leaseChecks = 0;
    const failures = [429, 503];
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-private-backups";
    setRuntimeR2Bucket({
      async head() {
        return stored;
      },
      async get() {
        return null;
      },
      async put(_exactKey, value, options) {
        putCalls += 1;
        const status = failures.shift();
        if (status) throw providerFailure(status);
        const sha256 = options?.sha256;
        if (!(sha256 instanceof ArrayBuffer)) throw new Error("expected SHA-256 bytes");
        stored = {
          size: value instanceof Uint8Array ? value.byteLength : 0,
          etag: "runtime-etag-b",
          version: "runtime-version-b",
          checksums: { sha256: sha256.slice(0) },
        };
        return stored;
      },
      async delete() {},
    });

    await expect(
      putImmutableObject({
        key,
        body: bytes(5, 6, 7),
        beforeWriteAttempt: async () => {
          leaseChecks += 1;
        },
      }),
    ).resolves.toMatchObject({
      verifiedPresent: true,
      metadata: { sizeBytes: 3 },
    });
    expect(putCalls).toBe(MAX_IMMUTABLE_PUT_ATTEMPTS);
    expect(leaseChecks).toBe(MAX_IMMUTABLE_PUT_ATTEMPTS);

    stored = null;
    putCalls = 0;
    failures.push(429, 503, 500, 500);
    await expectLifecycleError(
      putImmutableObject({ key: `${key}-exhausted`, body: bytes(8) }),
      "OBJECT_STORAGE_UPLOAD_RETRY_EXHAUSTED",
    );
    expect(putCalls).toBe(MAX_IMMUTABLE_PUT_ATTEMPTS);
  });

  test("never starts a later retry after its lease fence is rejected", async () => {
    const key = "agent-sandbox-backups/private-org/operation-retry-fenced/chunk-0001";
    let putCalls = 0;
    let leaseChecks = 0;
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-private-backups";
    setRuntimeR2Bucket({
      async head() {
        return null;
      },
      async get() {
        return null;
      },
      async put() {
        putCalls += 1;
        throw providerFailure(503);
      },
      async delete() {},
    });

    await expect(
      putImmutableObject({
        key,
        body: bytes(59),
        beforeWriteAttempt: async () => {
          leaseChecks += 1;
          if (leaseChecks === 2) throw new Error("lease generation expired");
        },
      }),
    ).rejects.toThrow("lease generation expired");
    expect(leaseChecks).toBe(2);
    expect(putCalls).toBe(1);
  });

  test("bounds a hung provider PUT with the absolute deadline and never starts HEAD", async () => {
    jest.useFakeTimers();
    const providerEntered = Promise.withResolvers<void>();
    const key = "agent-sandbox-backups/private-org/operation-hung/chunk-0001";
    let putCalls = 0;
    let headCalls = 0;
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-private-backups";
    setRuntimeR2Bucket({
      async head() {
        headCalls += 1;
        return null;
      },
      async get() {
        return null;
      },
      async put() {
        putCalls += 1;
        providerEntered.resolve();
        return new Promise<never>(() => undefined);
      },
      async delete() {},
    });

    const completed = expectLifecycleError(
      putImmutableObject({
        key,
        body: bytes(61, 62),
        deadline: new Date(Date.now() + 15),
      }),
      "OBJECT_STORAGE_UPLOAD_DEADLINE_EXCEEDED",
    );
    await providerEntered.promise;
    jest.advanceTimersByTime(15);
    await completed;
    expect(putCalls).toBe(1);
    expect(headCalls).toBe(0);
  });

  test("cancels a hung provider PUT from the caller signal without retrying", async () => {
    const key = "agent-sandbox-backups/private-org/operation-aborted/chunk-0001";
    const controller = new AbortController();
    let putCalls = 0;
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-private-backups";
    setRuntimeR2Bucket({
      async head() {
        throw new Error("aborted upload must not reach HEAD");
      },
      async get() {
        return null;
      },
      async put() {
        putCalls += 1;
        controller.abort();
        return new Promise<never>(() => undefined);
      },
      async delete() {},
    });

    await expectLifecycleError(
      putImmutableObject({ key, body: bytes(64), signal: controller.signal }),
      "OBJECT_STORAGE_UPLOAD_ABORTED",
    );
    expect(putCalls).toBe(1);
  });

  test("bounds the post-write verification HEAD with the same deadline", async () => {
    jest.useFakeTimers();
    const providerEntered = Promise.withResolvers<void>();
    const key = "agent-sandbox-backups/private-org/operation-hung-head/chunk-0001";
    let headCalls = 0;
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-private-backups";
    setRuntimeR2Bucket({
      async head() {
        headCalls += 1;
        providerEntered.resolve();
        return new Promise<never>(() => undefined);
      },
      async get() {
        return null;
      },
      async put(_exactKey, value, options) {
        const checksum = options?.sha256;
        if (!(checksum instanceof ArrayBuffer)) throw new Error("expected SHA-256 bytes");
        return {
          size: value instanceof Uint8Array ? value.byteLength : 0,
          etag: "hung-head-etag",
          version: "hung-head-version",
          checksums: { sha256: checksum.slice(0) },
        };
      },
      async delete() {},
    });

    const completed = expectLifecycleError(
      putImmutableObject({
        key,
        body: bytes(65),
        deadline: new Date(Date.now() + 15),
      }),
      "OBJECT_STORAGE_UPLOAD_DEADLINE_EXCEEDED",
    );
    await providerEntered.promise;
    jest.advanceTimersByTime(15);
    await completed;
    expect(headCalls).toBe(1);
  });

  test("does not start a retry after the shared deadline expires in backoff", async () => {
    jest.useFakeTimers();
    const providerEntered = Promise.withResolvers<void>();
    const key = "agent-sandbox-backups/private-org/operation-backoff-deadline/chunk-0001";
    let putCalls = 0;
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-private-backups";
    setRuntimeR2Bucket({
      async head() {
        return null;
      },
      async get() {
        return null;
      },
      async put() {
        putCalls += 1;
        providerEntered.resolve();
        throw providerFailure(503);
      },
      async delete() {},
    });

    const completed = expectLifecycleError(
      putImmutableObject({
        key,
        body: bytes(66),
        deadline: new Date(Date.now() + 10),
      }),
      "OBJECT_STORAGE_UPLOAD_DEADLINE_EXCEEDED",
    );
    await providerEntered.promise;
    await Promise.resolve();
    jest.advanceTimersByTime(10);
    await completed;
    expect(putCalls).toBe(1);
  });

  test("does not adopt a pre-existing object when the pre-write fence rejects", async () => {
    const key = "agent-sandbox-backups/private-org/operation-fenced/chunk-0001";
    let putCalls = 0;
    let headCalls = 0;
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-private-backups";
    setRuntimeR2Bucket({
      async head() {
        headCalls += 1;
        throw new Error("pre-existing object must not be inspected");
      },
      async get() {
        return null;
      },
      async put() {
        putCalls += 1;
        throw new Error("provider write must not start");
      },
      async delete() {},
    });

    await expect(
      putImmutableObject({
        key,
        body: bytes(63),
        beforeWriteAttempt: async () => {
          throw new Error("lease fence rejected");
        },
      }),
    ).rejects.toThrow("lease fence rejected");
    expect(putCalls).toBe(0);
    expect(headCalls).toBe(0);
  });

  test("does not treat forged uploader metadata as a provider-validated R2 checksum", async () => {
    const key = "agent-sandbox-backups/private-org/operation-forged-r2/chunk-0001";
    let stored: RuntimeR2ObjectMetadata | null = null;
    process.env.STORAGE_HEAVY_PAYLOADS_BUCKET = "runtime-private-backups";
    setRuntimeR2Bucket({
      async head() {
        return stored;
      },
      async get() {
        return null;
      },
      async put(_exactKey, value, options) {
        stored = {
          size: value instanceof Uint8Array ? value.byteLength : 0,
          etag: "forged-metadata-etag",
          version: "forged-metadata-version",
          customMetadata: options?.customMetadata,
        };
        return stored;
      },
      async delete() {},
    });

    await expectLifecycleError(
      putImmutableObject({ key, body: bytes(67, 68) }),
      "OBJECT_STORAGE_IMMUTABLE_CONFLICT",
    );
  });
});

describe("S3-compatible immutable exact-key upload", () => {
  test("uses If-None-Match and replays the same receipt on 412", async () => {
    configureS3();
    const key = "agent-sandbox-backups/private-org/operation-s3/chunk-0001";
    const first = await putImmutableObject({ key, body: bytes(10, 11, 12) });
    const replay = await putImmutableObject({ key, body: bytes(10, 11, 12) });
    expect(replay).toEqual(first);
    expect(s3Calls.filter(({ method }) => method === "PUT")).toHaveLength(2);
    expect(
      s3Calls
        .filter(({ method }) => method === "PUT")
        .every(({ ifNoneMatch }) => ifNoneMatch === "*"),
    ).toBe(true);
    expect(JSON.stringify(first)).not.toContain(key);
    expect(JSON.stringify(first)).not.toContain("immutable-upload-test-bucket");

    const mismatch = await expectLifecycleError(
      putImmutableObject({ key, body: bytes(12, 11, 10) }),
      "OBJECT_STORAGE_IMMUTABLE_CONFLICT",
    );
    expect(String(mismatch)).not.toContain(key);
    expect(s3Calls.filter(({ method }) => method === "PUT")).toHaveLength(3);
  });

  test("recovers a success whose response became 5xx without a second PUT", async () => {
    configureS3();
    const key = "agent-sandbox-backups/private-org/operation-loss/chunk-0001";
    s3PutBehaviors.set(key, [{ status: 500, persist: true }]);

    const receipt = await putImmutableObject({ key, body: bytes(21, 22, 23, 24) });
    expect(receipt).toMatchObject({ verifiedPresent: true, metadata: { sizeBytes: 4 } });
    expect(s3Calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
    expect(s3Calls.filter(({ method }) => method === "HEAD")).toHaveLength(1);
  });

  test("reconciles 429/5xx and keeps the transport retry count bounded", async () => {
    configureS3();
    const key = "agent-sandbox-backups/private-org/operation-retry/chunk-0001";
    s3PutBehaviors.set(key, [
      { status: 429, persist: false },
      { status: 503, persist: false },
    ]);

    await expect(putImmutableObject({ key, body: bytes(31, 32) })).resolves.toMatchObject({
      verifiedPresent: true,
      metadata: { sizeBytes: 2 },
    });
    expect(s3Calls.filter(({ method }) => method === "PUT")).toHaveLength(
      MAX_IMMUTABLE_PUT_ATTEMPTS,
    );
    expect(s3Calls.filter(({ method }) => method === "HEAD")).toHaveLength(
      MAX_IMMUTABLE_PUT_ATTEMPTS,
    );
  });

  test("fails closed when the compatible provider lacks conditional PUT", async () => {
    configureS3();
    const key = "agent-sandbox-backups/private-org/operation-unsupported/chunk-0001";
    s3PutBehaviors.set(key, [{ status: 501, persist: false }]);

    const error = await expectLifecycleError(
      putImmutableObject({ key, body: bytes(41) }),
      "OBJECT_STORAGE_IMMUTABLE_PUT_UNSUPPORTED",
    );
    expect(String(error)).not.toContain(key);
    expect(s3Calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
    expect(s3Objects.has(key)).toBe(false);
  });

  test("never adopts matching bytes persisted by unsupported or fatal PUT responses", async () => {
    configureS3();
    const unsupportedKey =
      "agent-sandbox-backups/private-org/operation-unsupported-persisted/chunk-0001";
    s3PutBehaviors.set(unsupportedKey, [{ status: 501, persist: true }]);
    await expectLifecycleError(
      putImmutableObject({ key: unsupportedKey, body: bytes(42) }),
      "OBJECT_STORAGE_IMMUTABLE_PUT_UNSUPPORTED",
    );
    expect(s3Objects.has(unsupportedKey)).toBe(true);
    expect(
      s3Calls.filter(({ method, key }) => method === "HEAD" && key === unsupportedKey),
    ).toHaveLength(0);

    const fatalKey = "agent-sandbox-backups/private-org/operation-fatal-persisted/chunk-0001";
    s3PutBehaviors.set(fatalKey, [{ status: 400, persist: true }]);
    await expectLifecycleError(
      putImmutableObject({ key: fatalKey, body: bytes(43) }),
      "OBJECT_STORAGE_UPLOAD_FAILED",
    );
    expect(s3Objects.has(fatalKey)).toBe(true);
    expect(s3Calls.filter(({ method, key }) => method === "HEAD" && key === fatalKey)).toHaveLength(
      0,
    );
  });

  test("does not adopt a same-size S3 object with forged checksum metadata", async () => {
    configureS3();
    const key = "agent-sandbox-backups/private-org/operation-forged-s3/chunk-0001";
    const expectedBody = bytes(44, 45);
    const expectedSha256 = Buffer.from(
      await crypto.subtle.digest("SHA-256", expectedBody),
    ).toString("base64");
    const corruptSha256 = Buffer.from(
      await crypto.subtle.digest("SHA-256", bytes(45, 44)),
    ).toString("base64");
    s3Objects.set(key, {
      size: expectedBody.byteLength,
      providerSha256: corruptSha256,
      declaredSha256: expectedSha256,
      exposeProviderChecksum: false,
      etag: "forged-s3-etag",
      version: "forged-s3-version",
    });

    await expectLifecycleError(
      putImmutableObject({ key, body: expectedBody }),
      "OBJECT_STORAGE_IMMUTABLE_CONFLICT",
    );
  });

  test("aborts a hung secondary-compatible PUT at the shared absolute deadline", async () => {
    configureS3();
    const key = "agent-sandbox-backups/private-org/operation-s3-hung/chunk-0001";
    s3PutBehaviors.set(key, [{ status: 200, persist: true, delayMs: 150 }]);

    await expectLifecycleError(
      putImmutableObject({
        key,
        body: bytes(71, 72),
        deadline: new Date(Date.now() + 20),
      }),
      "OBJECT_STORAGE_UPLOAD_DEADLINE_EXCEEDED",
    );
    expect(s3Calls.filter(({ method }) => method === "HEAD")).toHaveLength(0);
  });
});
