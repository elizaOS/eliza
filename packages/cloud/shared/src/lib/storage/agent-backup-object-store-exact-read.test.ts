/**
 * Exact streamed backup reads across native Worker R2 and an S3-compatible
 * HTTP boundary, including authority, generation, integrity, and abort gates.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AgentBackupS3Endpoint,
  type AgentBackupWorkerR2Endpoint,
  createAgentBackupObjectStore,
} from "./agent-backup-object-store";
import {
  type ExactObjectRead,
  MAX_EXACT_OBJECT_READ_BYTES,
  ObjectLocatorReceipt,
  type ObjectLocatorVersionSource,
} from "./object-store";
import type {
  RuntimeR2Bucket,
  RuntimeR2GetOptions,
  RuntimeR2ObjectMetadata,
  RuntimeR2PutOptions,
} from "./r2-runtime-binding";

type RuntimeReadMode =
  | "normal"
  | "truncated"
  | "overflow"
  | "corrupt"
  | "response-loss"
  | "slow"
  | "invalid-metadata";

interface RuntimeStoredObject extends RuntimeR2ObjectMetadata {
  bodyBytes: Uint8Array;
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    output += alphabet.charAt(first >> 2);
    output += alphabet.charAt(((first & 0x03) << 4) | (second >> 4));
    output +=
      index + 1 < bytes.length ? alphabet.charAt(((second & 0x0f) << 2) | (third >> 6)) : "=";
    output += index + 2 < bytes.length ? alphabet.charAt(third & 0x3f) : "=";
  }
  return output;
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return owned;
}

async function sha256(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; hex: string; base64: string }> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBytes(bytes)));
  return {
    bytes: digest,
    hex: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    base64: bytesToBase64(digest),
  };
}

async function drain(read: ExactObjectRead): Promise<Uint8Array> {
  const output: number[] = [];
  const reader = read.body.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    output.push(...next.value);
  }
  return Uint8Array.from(output);
}

function makeRuntimeBucket(): {
  bucket: RuntimeR2Bucket;
  getCalls: Array<{ key: string; options: RuntimeR2GetOptions | undefined }>;
  headCalls: string[];
  providerPullCount(): number;
  providerCancelCount(): number;
  setReadMode(mode: RuntimeReadMode): void;
  setCancelHangs(value: boolean): void;
  setDeclaredSize(key: string, size: number): void;
  changeGeneration(key: string): void;
} {
  const objects = new Map<string, RuntimeStoredObject>();
  const getCalls: Array<{ key: string; options: RuntimeR2GetOptions | undefined }> = [];
  const headCalls: string[] = [];
  let mode: RuntimeReadMode = "normal";
  let pulls = 0;
  let cancels = 0;
  let cancelHangs = false;

  const streamFor = (stored: RuntimeStoredObject): ReadableStream<Uint8Array> => {
    let bytes = stored.bodyBytes.slice();
    if (mode === "truncated") bytes = bytes.slice(0, Math.max(0, bytes.byteLength - 1));
    if (mode === "overflow") {
      const oversized = new Uint8Array(bytes.byteLength + 1);
      oversized.set(bytes);
      oversized[oversized.length - 1] = 0xff;
      bytes = oversized;
    }
    if (mode === "corrupt" && bytes.byteLength > 0) bytes[0] ^= 0xff;
    let offset = 0;
    let cancelled = false;
    let responseLost = false;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 50));
        if (cancelled) return;
        if (mode === "response-loss" && responseLost) {
          controller.error(new TypeError("simulated provider response loss"));
          return;
        }
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + 1));
        offset += 1;
        if (mode === "response-loss") responseLost = true;
      },
      async cancel() {
        cancelled = true;
        if (cancelHangs) return new Promise<never>(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 2));
        cancels += 1;
      },
    });
  };

  return {
    getCalls,
    headCalls,
    providerPullCount: () => pulls,
    providerCancelCount: () => cancels,
    setReadMode(nextMode) {
      mode = nextMode;
    },
    setCancelHangs(value) {
      cancelHangs = value;
    },
    setDeclaredSize(key, size) {
      const stored = objects.get(key);
      if (stored) stored.size = size;
    },
    changeGeneration(key) {
      const stored = objects.get(key);
      if (stored) stored.version = `${stored.version}-replaced`;
    },
    bucket: {
      async head(key) {
        headCalls.push(key);
        return objects.get(key) ?? null;
      },
      async get(key, options) {
        getCalls.push({ key, options });
        const stored = objects.get(key);
        if (!stored) return null;
        const onlyIf = options?.onlyIf;
        if (
          onlyIf &&
          !(onlyIf instanceof Headers) &&
          onlyIf.etagMatches &&
          onlyIf.etagMatches !== stored.etag
        ) {
          return {
            ...stored,
            async text() {
              return "";
            },
          };
        }
        const body = streamFor(stored);
        return {
          ...stored,
          etag: mode === "invalid-metadata" ? "" : stored.etag,
          body,
          async text() {
            return new TextDecoder().decode(stored.bodyBytes);
          },
        };
      },
      async put(key, body, options?: RuntimeR2PutOptions) {
        if (objects.has(key)) return null;
        if (!(body instanceof Uint8Array)) throw new Error("Expected byte body");
        const checksum = options?.sha256;
        if (!(checksum instanceof ArrayBuffer)) throw new Error("Expected SHA-256 bytes");
        const stored: RuntimeStoredObject = {
          bodyBytes: body.slice(),
          size: body.byteLength,
          etag: `etag-${key.length}`,
          version: `version-${key.length}`,
          checksums: { sha256: checksum.slice(0) },
          customMetadata: options?.customMetadata,
        };
        objects.set(key, stored);
        return stored;
      },
      async delete(key) {
        objects.delete(key);
      },
    },
  };
}

function workerEndpoint(
  bucketBinding: RuntimeR2Bucket,
  overrides: Partial<AgentBackupWorkerR2Endpoint> = {},
): AgentBackupWorkerR2Endpoint {
  return {
    provider: "cloudflare-r2",
    transport: "worker-r2",
    endpointAlias: "r2-primary-eu",
    accountIdentity: "cloudflare-account-a",
    bindingIdentity: "BACKUP_PRIMARY",
    bucket: "sandbox-backup-primary",
    region: "auto",
    bucketBinding,
    ...overrides,
  };
}

interface S3StoredObject {
  body: Uint8Array;
  sha256: string;
  etag: string;
  version: string;
}

const s3Objects = new Map<string, S3StoredObject>();
const s3Requests: Array<{
  method: string;
  key: string;
  version: string | null;
  ifMatch: string | null;
  checksumMode: string | null;
}> = [];
let s3Server: ReturnType<typeof Bun.serve>;

function parseS3Request(request: Request): { key: string; version: string | null } {
  const url = new URL(request.url);
  const path = url.pathname.slice(1);
  const separator = path.indexOf("/");
  return {
    key: separator < 0 ? "" : decodeURIComponent(path.slice(separator + 1)),
    version: url.searchParams.get("versionId"),
  };
}

function s3Error(code: string, status: number): Response {
  return new Response(`<Error><Code>${code}</Code></Error>`, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

function s3Endpoint(overrides: Partial<AgentBackupS3Endpoint> = {}): AgentBackupS3Endpoint {
  return {
    provider: "hetzner-object-storage",
    transport: "s3-compatible",
    endpointAlias: "hetzner-secondary-fsn1",
    accountIdentity: "hetzner-project-a",
    endpoint: `http://127.0.0.1:${s3Server.port}`,
    accessKeyId: "hetzner-access-a",
    secretAccessKey: "test-secret",
    bucket: "sandbox-backup-secondary",
    region: "fsn1",
    forcePathStyle: true,
    ...overrides,
  };
}

beforeAll(() => {
  s3Server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const parsed = parseS3Request(request);
      s3Requests.push({
        method: request.method,
        ...parsed,
        ifMatch: request.headers.get("if-match"),
        checksumMode: request.headers.get("x-amz-checksum-mode"),
      });
      const stored = s3Objects.get(parsed.key);
      const exposesProviderVersion = !parsed.key.includes("/unversioned/");
      if (request.method === "HEAD") {
        if (!stored) return s3Error("NoSuchKey", 404);
        const headers: Record<string, string> = {
          "content-length": String(stored.body.byteLength),
          etag: `"${stored.etag}"`,
          "x-amz-checksum-sha256": stored.sha256,
          "x-amz-meta-eliza-content-sha256": stored.sha256,
        };
        if (exposesProviderVersion) headers["x-amz-version-id"] = stored.version;
        return new Response(null, {
          headers,
        });
      }
      if (request.method === "PUT") {
        if (request.headers.get("if-none-match") !== "*") return s3Error("NotImplemented", 501);
        if (stored) return s3Error("PreconditionFailed", 412);
        const body = new Uint8Array(await request.arrayBuffer());
        const checksum =
          request.headers.get("x-amz-checksum-sha256") ??
          request.headers.get("x-amz-meta-eliza-content-sha256") ??
          "";
        s3Objects.set(parsed.key, {
          body,
          sha256: checksum,
          etag: `etag-${parsed.key.length}`,
          version: `version-${parsed.key.length}`,
        });
        return new Response(null, { status: 200 });
      }
      if (request.method === "GET") {
        if (request.headers.has("x-amz-checksum-mode")) return s3Error("NotImplemented", 501);
        if (!stored) return s3Error("NoSuchKey", 404);
        if (parsed.version && parsed.version !== stored.version) {
          return s3Error("NoSuchVersion", 404);
        }
        const ifMatch = request.headers.get("if-match")?.replace(/^"|"$/g, "");
        if (ifMatch && ifMatch !== stored.etag) return s3Error("PreconditionFailed", 412);
        const headers: Record<string, string> = {
          "content-length": String(stored.body.byteLength),
          etag: `"${stored.etag}"`,
          "x-amz-checksum-sha256": stored.sha256,
          "x-amz-meta-eliza-content-sha256": stored.sha256,
        };
        if (exposesProviderVersion) headers["x-amz-version-id"] = stored.version;
        return new Response(ownedBytes(stored.body).buffer, {
          headers,
        });
      }
      return new Response(null, { status: 405 });
    },
  });
});

afterAll(() => {
  s3Server.stop(true);
});

describe("agent backup exact streamed reads", () => {
  test("streams one exact Worker R2 generation with bounded backpressure and EOF completion", async () => {
    const runtime = makeRuntimeBucket();
    const store = await createAgentBackupObjectStore(workerEndpoint(runtime.bucket));
    const key = "agent-sandbox-backups/org-read/backup-read/chunk-0000";
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const digest = await sha256(bytes);
    const uploaded = await store.putImmutable({ key, body: bytes });
    const headCount = runtime.headCalls.length;

    const read = await store.getExactObject({
      locator: { key, receipt: uploaded.locator },
      expectedSize: bytes.byteLength,
      expectedCipherSha256: digest.hex,
    });
    expect(read).not.toHaveProperty("locator");
    expect(read).not.toHaveProperty("verifiedComplete");
    expect(read.declaredMetadata).toEqual(uploaded.metadata);
    expect(Object.isFrozen(read)).toBeTrue();
    expect(Object.isFrozen(read.declaredMetadata)).toBeTrue();
    expect(Object.isFrozen(read.declaredMetadata.checksum)).toBeTrue();
    expect(runtime.getCalls).toHaveLength(1);
    expect(runtime.getCalls[0]?.key).toBe(key);
    expect(runtime.headCalls).toHaveLength(headCount);

    let completionSettled = false;
    void read.completion.then(() => {
      completionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pullsBeforeConsumption = runtime.providerPullCount();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(completionSettled).toBeFalse();
    expect(runtime.providerPullCount()).toBe(pullsBeforeConsumption);
    expect(pullsBeforeConsumption).toBeLessThanOrEqual(2);

    await expect(drain(read)).resolves.toEqual(bytes);
    const completed = await read.completion;
    expect(completed).toMatchObject({
      locator: uploaded.locator,
      metadata: uploaded.metadata,
      verifiedComplete: true,
    });
    expect(Object.isFrozen(completed)).toBeTrue();
  });

  test("fails closed on truncation, overflow, hash mismatch, and response loss; exact retry succeeds", async () => {
    const runtime = makeRuntimeBucket();
    const store = await createAgentBackupObjectStore(workerEndpoint(runtime.bucket));
    const key = "agent-sandbox-backups/org-read/backup-failures/chunk-0000";
    const bytes = new Uint8Array([9, 8, 7]);
    const digest = await sha256(bytes);
    const uploaded = await store.putImmutable({ key, body: bytes });
    const cases: Array<{ mode: RuntimeReadMode; code: string }> = [
      { mode: "truncated", code: "OBJECT_STORAGE_READ_TRUNCATED" },
      { mode: "overflow", code: "OBJECT_STORAGE_READ_OVERFLOW" },
      { mode: "corrupt", code: "OBJECT_STORAGE_READ_HASH_MISMATCH" },
      { mode: "response-loss", code: "OBJECT_STORAGE_READ_FAILED" },
    ];

    for (const failure of cases) {
      runtime.setReadMode(failure.mode);
      const read = await store.getExactObject({
        locator: { key, receipt: uploaded.locator },
        expectedSize: bytes.byteLength,
        expectedCipherSha256: digest.hex,
      });
      await expect(drain(read)).rejects.toMatchObject({ code: failure.code });
      await expect(read.completion).rejects.toMatchObject({ code: failure.code });
    }

    runtime.setReadMode("normal");
    const retry = await store.getExactObject({
      locator: { key, receipt: uploaded.locator },
      expectedSize: bytes.byteLength,
      expectedCipherSha256: digest.hex,
    });
    await expect(drain(retry)).resolves.toEqual(bytes);
    await expect(retry.completion).resolves.toMatchObject({ verifiedComplete: true });
  });

  test("checks the cap before I/O and refuses mismatched provider headers before exposure", async () => {
    const runtime = makeRuntimeBucket();
    const store = await createAgentBackupObjectStore(workerEndpoint(runtime.bucket));
    const key = "agent-sandbox-backups/org-read/backup-headers/chunk-0000";
    const bytes = new Uint8Array([3, 2, 1]);
    const digest = await sha256(bytes);
    const uploaded = await store.putImmutable({ key, body: bytes });
    const exactLocator = { key, receipt: uploaded.locator };
    const getCount = runtime.getCalls.length;

    const forgedVersionSource = new ObjectLocatorReceipt({
      transport: uploaded.locator.transport,
      provider: uploaded.locator.provider,
      endpointAlias: uploaded.locator.endpointAlias,
      backendIdentityFingerprint: uploaded.locator.backendIdentityFingerprint,
      bucket: uploaded.locator.bucket,
      region: uploaded.locator.region,
      keyFingerprint: uploaded.locator.keyFingerprint,
      version: uploaded.locator.version,
      versionSource: "bogus" as ObjectLocatorVersionSource,
    });
    await expect(
      store.getExactObject({
        locator: { key, receipt: forgedVersionSource },
        expectedSize: bytes.byteLength,
        expectedCipherSha256: digest.hex,
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_LOCATOR_UNAVAILABLE" });
    expect(runtime.getCalls).toHaveLength(getCount);

    await expect(
      store.getExactObject({
        locator: exactLocator,
        expectedSize: MAX_EXACT_OBJECT_READ_BYTES + 1,
        expectedCipherSha256: digest.hex,
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_READ_TOO_LARGE" });
    expect(runtime.getCalls).toHaveLength(getCount);

    runtime.setDeclaredSize(key, MAX_EXACT_OBJECT_READ_BYTES);
    const maximum = await store.getExactObject({
      locator: exactLocator,
      expectedSize: MAX_EXACT_OBJECT_READ_BYTES,
      expectedCipherSha256: digest.hex,
    });
    expect(maximum.declaredMetadata.sizeBytes).toBe(MAX_EXACT_OBJECT_READ_BYTES);
    await expect(drain(maximum)).rejects.toMatchObject({
      code: "OBJECT_STORAGE_READ_TRUNCATED",
    });
    await expect(maximum.completion).rejects.toMatchObject({
      code: "OBJECT_STORAGE_READ_TRUNCATED",
    });
    runtime.setDeclaredSize(key, bytes.byteLength);

    await expect(
      store.getExactObject({
        locator: exactLocator,
        expectedSize: bytes.byteLength + 1,
        expectedCipherSha256: digest.hex,
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_METADATA_INVALID" });
    await expect(
      store.getExactObject({
        locator: exactLocator,
        expectedSize: bytes.byteLength,
        expectedCipherSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_METADATA_INVALID" });
    runtime.setReadMode("invalid-metadata");
    const cancelCountBeforeInvalidMetadata = runtime.providerCancelCount();
    await expect(
      store.getExactObject({
        locator: exactLocator,
        expectedSize: bytes.byteLength,
        expectedCipherSha256: digest.hex,
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_METADATA_INVALID" });
    expect(runtime.providerCancelCount()).toBe(cancelCountBeforeInvalidMetadata + 1);
    expect(runtime.getCalls).toHaveLength(getCount + 4);
    expect(runtime.providerCancelCount()).toBeGreaterThanOrEqual(3);

    runtime.setCancelHangs(true);
    const hungCancelStartedAt = Date.now();
    await expect(
      store.getExactObject({
        locator: exactLocator,
        expectedSize: bytes.byteLength,
        expectedCipherSha256: digest.hex,
        deadline: new Date(Date.now() + 10),
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_METADATA_INVALID" });
    expect(Date.now() - hungCancelStartedAt).toBeLessThan(250);
    runtime.setCancelHangs(false);

    const emptyKey = "agent-sandbox-backups/org-read/backup-headers/chunk-empty";
    const empty = new Uint8Array();
    const emptyDigest = await sha256(empty);
    runtime.setReadMode("normal");
    const emptyUpload = await store.putImmutable({ key: emptyKey, body: empty });
    runtime.setReadMode("overflow");
    const overflow = await store.getExactObject({
      locator: { key: emptyKey, receipt: emptyUpload.locator },
      expectedSize: 0,
      expectedCipherSha256: emptyDigest.hex,
    });
    await expect(overflow.body.getReader().read()).rejects.toMatchObject({
      code: "OBJECT_STORAGE_READ_OVERFLOW",
    });
    await expect(overflow.completion).rejects.toMatchObject({
      code: "OBJECT_STORAGE_READ_OVERFLOW",
    });
  });

  test("rejects cancellation, abort, deadline, generation changes, and backend repoints", async () => {
    const runtime = makeRuntimeBucket();
    const original = await createAgentBackupObjectStore(workerEndpoint(runtime.bucket));
    const key = "agent-sandbox-backups/org-read/backup-authority/chunk-0000";
    const bytes = new Uint8Array([5, 6, 7]);
    const digest = await sha256(bytes);
    const uploaded = await original.putImmutable({ key, body: bytes });

    runtime.setReadMode("normal");
    const cancelled = await original.getExactObject({
      locator: { key, receipt: uploaded.locator },
      expectedSize: bytes.byteLength,
      expectedCipherSha256: digest.hex,
    });
    const cancelCountBefore = runtime.providerCancelCount();
    await cancelled.body.cancel();
    expect(runtime.providerCancelCount()).toBe(cancelCountBefore + 1);
    await expect(cancelled.completion).rejects.toMatchObject({
      code: "OBJECT_STORAGE_READ_CANCELLED",
    });

    runtime.setReadMode("slow");
    const abortController = new AbortController();
    const aborted = await original.getExactObject({
      locator: { key, receipt: uploaded.locator },
      expectedSize: bytes.byteLength,
      expectedCipherSha256: digest.hex,
      signal: abortController.signal,
    });
    const abortedDrain = drain(aborted);
    abortController.abort();
    await expect(abortedDrain).rejects.toMatchObject({ code: "OBJECT_STORAGE_READ_ABORTED" });
    await expect(aborted.completion).rejects.toMatchObject({
      code: "OBJECT_STORAGE_READ_ABORTED",
    });
    expect(runtime.providerCancelCount()).toBeGreaterThanOrEqual(1);

    const deadlineRead = await original.getExactObject({
      locator: { key, receipt: uploaded.locator },
      expectedSize: bytes.byteLength,
      expectedCipherSha256: digest.hex,
      deadline: new Date(Date.now() + 5),
    });
    await expect(drain(deadlineRead)).rejects.toMatchObject({
      code: "OBJECT_STORAGE_READ_DEADLINE_EXCEEDED",
    });
    await expect(deadlineRead.completion).rejects.toMatchObject({
      code: "OBJECT_STORAGE_READ_DEADLINE_EXCEEDED",
    });

    const getCountBeforeDeadline = runtime.getCalls.length;
    await expect(
      original.getExactObject({
        locator: { key, receipt: uploaded.locator },
        expectedSize: bytes.byteLength,
        expectedCipherSha256: digest.hex,
        deadline: new Date(Date.now() - 1),
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_READ_DEADLINE_EXCEEDED" });
    expect(runtime.getCalls).toHaveLength(getCountBeforeDeadline);

    runtime.setReadMode("normal");
    runtime.changeGeneration(key);
    await expect(
      original.getExactObject({
        locator: { key, receipt: uploaded.locator },
        expectedSize: bytes.byteLength,
        expectedCipherSha256: digest.hex,
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_VERSION_MISMATCH" });

    const repointed = await createAgentBackupObjectStore(
      workerEndpoint(runtime.bucket, { accountIdentity: "cloudflare-account-repointed" }),
    );
    const getCountBeforeRepoint = runtime.getCalls.length;
    await expect(
      repointed.getExactObject({
        locator: { key, receipt: uploaded.locator },
        expectedSize: bytes.byteLength,
        expectedCipherSha256: digest.hex,
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_LOCATOR_MISMATCH" });
    expect(runtime.getCalls).toHaveLength(getCountBeforeRepoint);
  });

  test("GETs one exact Hetzner S3 key/version and refuses an account repoint before I/O", async () => {
    s3Objects.clear();
    s3Requests.length = 0;
    const original = await createAgentBackupObjectStore(s3Endpoint());
    const key = "agent-sandbox-backups/org-read/backup-secondary/chunk-0000";
    const bytes = new Uint8Array([11, 12, 13, 14]);
    const digest = await sha256(bytes);
    const uploaded = await original.putImmutable({ key, body: bytes });
    const requestsBeforeRead = s3Requests.length;

    const read = await original.getExactObject({
      locator: { key, receipt: uploaded.locator },
      expectedSize: bytes.byteLength,
      expectedCipherSha256: digest.hex,
    });
    await expect(drain(read)).resolves.toEqual(bytes);
    await expect(read.completion).resolves.toMatchObject({ verifiedComplete: true });
    const readRequests = s3Requests.slice(requestsBeforeRead);
    expect(readRequests).toEqual([
      {
        method: "GET",
        key,
        version: uploaded.locator.version,
        ifMatch: null,
        checksumMode: null,
      },
    ]);

    const repointed = await createAgentBackupObjectStore(
      s3Endpoint({ accountIdentity: "hetzner-project-repointed" }),
    );
    const requestsBeforeRepoint = s3Requests.length;
    await expect(
      repointed.getExactObject({
        locator: { key, receipt: uploaded.locator },
        expectedSize: bytes.byteLength,
        expectedCipherSha256: digest.hex,
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_LOCATOR_MISMATCH" });
    expect(s3Requests).toHaveLength(requestsBeforeRepoint);
  });

  test("pins an unversioned Hetzner object with a quoted If-Match ETag", async () => {
    s3Objects.clear();
    s3Requests.length = 0;
    const store = await createAgentBackupObjectStore(s3Endpoint());
    const key = "agent-sandbox-backups/org-read/unversioned/chunk-0000";
    const bytes = new Uint8Array([21, 22]);
    const digest = await sha256(bytes);
    const uploaded = await store.putImmutable({ key, body: bytes });
    expect(uploaded.locator).toMatchObject({ versionSource: "etag" });
    const requestsBeforeRead = s3Requests.length;

    const read = await store.getExactObject({
      locator: { key, receipt: uploaded.locator },
      expectedSize: bytes.byteLength,
      expectedCipherSha256: digest.hex,
    });
    await expect(drain(read)).resolves.toEqual(bytes);
    await expect(read.completion).resolves.toMatchObject({ verifiedComplete: true });
    expect(s3Requests.slice(requestsBeforeRead)).toEqual([
      {
        method: "GET",
        key,
        version: null,
        ifMatch: `"${uploaded.locator.version}"`,
        checksumMode: null,
      },
    ]);
  });
});
