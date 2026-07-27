/**
 * Exercises the Cloud adapter that commits and restores canonical snapshot-v2
 * streams across the encrypted chunk store and the real HTTP body boundary.
 */

import { describe, expect, test } from "bun:test";
import type { StoredAgentSandboxBackup } from "../../db/schemas/agent-sandboxes";
import {
  type AgentSnapshotV2CloudDependencies,
  agentSnapshotV2RestoreTimeoutMs,
  captureAgentSnapshotV2,
  restoreAgentSnapshotV2,
} from "./agent-snapshot-v2-cloud";
import {
  AGENT_SNAPSHOT_V2_CHUNK_BYTES,
  AGENT_SNAPSHOT_V2_CONTENT_TYPE,
  AGENT_SNAPSHOT_V2_FORMAT,
  AGENT_SNAPSHOT_V2_MAX_WIRE_BYTES,
  AGENT_SNAPSHOT_V2_TRANSFER,
  type AgentSnapshotV2Descriptor,
  agentSnapshotV2Sha256,
  agentSnapshotV2Sha256Json,
  agentSnapshotV2StableJson,
} from "./agent-snapshot-v2-stream";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const SANDBOX_RECORD_ID = "00000000-0000-4000-8000-000000000002";
const BACKUP_ID = "00000000-0000-4000-8000-000000000003";
const AGENT_ID = "00000000-0000-4000-8000-000000000004";
const CREATED_AT = new Date("2026-07-26T12:00:00.000Z");

function canonicalSnapshot(): {
  bytes: Uint8Array;
  aggregateSha256: string;
  descriptor: AgentSnapshotV2Descriptor;
} {
  const identitySha256 = "ab".repeat(32);
  const databaseSha256 = agentSnapshotV2Sha256Json({
    algorithm: "sha256",
    identitySha256,
    identityVersion: 1,
    kind: "external-postgres-reference",
  });
  const descriptor: AgentSnapshotV2Descriptor = {
    agentId: AGENT_ID,
    chunkSize: AGENT_SNAPSHOT_V2_CHUNK_BYTES,
    components: {
      character: {
        configFileIndex: null,
        kind: "character-config",
        sha256: agentSnapshotV2Sha256Json({ configFile: null }),
      },
      database: {
        externalPostgres: {
          algorithm: "sha256",
          identitySha256,
          identityVersion: 1,
          kind: "external-postgres-reference",
          sha256: databaseSha256,
        },
        kind: "external-postgres-reference",
        sha256: databaseSha256,
      },
      media: {
        fileIndices: [],
        kind: "file-set",
        sha256: agentSnapshotV2Sha256Json([]),
      },
      stateFiles: {
        fileIndices: [],
        kind: "file-set",
        sha256: agentSnapshotV2Sha256Json([]),
      },
      vault: {
        fileIndices: [],
        kind: "file-set",
        sha256: agentSnapshotV2Sha256Json([]),
      },
    },
    createdAt: CREATED_AT.toISOString(),
    files: [],
    format: AGENT_SNAPSHOT_V2_FORMAT,
    schemaVersion: 2,
    transfer: AGENT_SNAPSHOT_V2_TRANSFER,
    type: "descriptor",
  };
  const aggregateSha256 = agentSnapshotV2Sha256(new Uint8Array());
  const trailer = {
    aggregateSha256,
    chunkCount: 0,
    descriptorSha256: agentSnapshotV2Sha256(agentSnapshotV2StableJson(descriptor)),
    fileCount: 0,
    totalBytes: 0,
    type: "trailer" as const,
  };
  return {
    aggregateSha256,
    bytes: new TextEncoder().encode(
      `${agentSnapshotV2StableJson(descriptor)}\n${agentSnapshotV2StableJson(trailer)}\n`,
    ),
    descriptor,
  };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function* replay(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  const split = Math.max(1, Math.floor(bytes.byteLength / 3));
  for (let offset = 0; offset < bytes.byteLength; offset += split) {
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + split));
  }
}

function storedBackup(contentHash: string): StoredAgentSandboxBackup {
  return {
    backup_kind: "full",
    content_hash: contentHash,
    created_at: CREATED_AT,
    id: BACKUP_ID,
    parent_backup_id: null,
    sandbox_record_id: SANDBOX_RECORD_ID,
    size_bytes: 1_024,
    snapshot_schema_version: 2,
    snapshot_type: "pre-upgrade",
    state_data: { config: {}, memories: [], workspaceFiles: {} },
    state_data_descriptor: {
      backupId: BACKUP_ID,
      backupSchemaVersion: 2,
      chunkBytes: 1_024,
      chunks: [],
      commitState: "complete",
      createdAt: CREATED_AT.toISOString(),
      descriptorVersion: 1,
      format: "elizaos.agent-backup-chunks",
      objectSetId: "00000000-0000-4000-8000-000000000005",
      organizationId: ORGANIZATION_ID,
      sandboxRecordId: SANDBOX_RECORD_ID,
      totalPlaintextBytes: 1_024,
      totalPlaintextSha256: "cd".repeat(32),
    },
    state_data_key: null,
    state_data_storage: "chunked-v2",
    storage_commit_error: null,
    storage_commit_state: "complete",
    storage_commit_updated_at: CREATED_AT,
    verification_error: null,
    verification_status: "verified",
    verified_at: CREATED_AT,
  };
}

describe("agent snapshot v2 Cloud adapter", () => {
  test("commits only after the stored encrypted stream matches the source", async () => {
    const snapshot = canonicalSnapshot();
    let stagedBytes: Uint8Array | undefined;
    let createCalls = 0;
    const dependencies: AgentSnapshotV2CloudDependencies = {
      fetch,
      readStored: () => replay(new Uint8Array()),
      storage: {
        async create(params) {
          createCalls += 1;
          expect(params.maxTotalBytes).toBe(AGENT_SNAPSHOT_V2_MAX_WIRE_BYTES);
          stagedBytes = await collect(params.source);
          const verification = await params.verify(replay(stagedBytes));
          return storedBackup(verification.contentHash);
        },
      },
    };

    const result = await captureAgentSnapshotV2({
      agentId: AGENT_ID,
      backupId: BACKUP_ID,
      dependencies,
      organizationId: ORGANIZATION_ID,
      response: new Response(replay(snapshot.bytes), {
        headers: { "Content-Type": AGENT_SNAPSHOT_V2_CONTENT_TYPE },
      }),
      sandboxRecordId: SANDBOX_RECORD_ID,
    });

    expect(createCalls).toBe(1);
    expect(stagedBytes).toEqual(snapshot.bytes);
    expect(result.backup.content_hash).toBe(snapshot.aggregateSha256);
    expect(result.summary.descriptor).toEqual(snapshot.descriptor);
    expect(result.summary.trailer.aggregateSha256).toBe(snapshot.aggregateSha256);
  });

  test("streams a verified stored snapshot into restore and accepts only its exact acknowledgement", async () => {
    const snapshot = canonicalSnapshot();
    let requestBytes: Uint8Array | undefined;
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = init?.body;
      if (!(body instanceof ReadableStream)) {
        throw new Error("restore request body is not a stream");
      }
      requestBytes = new Uint8Array(await new Response(body).arrayBuffer());
      expect(new Headers(init.headers).get("content-type")).toBe(AGENT_SNAPSHOT_V2_CONTENT_TYPE);
      return new Response(
        JSON.stringify({
          aggregateSha256: snapshot.aggregateSha256,
          fileCount: 0,
          requiresRestart: true,
          schemaVersion: 2,
          success: true,
          totalBytes: 0,
          transfer: "chunked-v1",
        }),
      );
    };
    const dependencies: AgentSnapshotV2CloudDependencies = {
      fetch: fakeFetch,
      readStored: () => replay(snapshot.bytes),
      storage: {
        async create() {
          throw new Error("restore must not create a backup");
        },
      },
    };

    const result = await restoreAgentSnapshotV2({
      agentId: AGENT_ID,
      backup: storedBackup(snapshot.aggregateSha256),
      dependencies,
      endpoint: "https://agent.example/api/restore?transfer=chunked-v1",
      headers: {
        Authorization: "Bearer opaque",
        "content-type": "application/json",
      },
      organizationId: ORGANIZATION_ID,
    });

    expect(requestBytes).toEqual(snapshot.bytes);
    expect(result.trailer.aggregateSha256).toBe(snapshot.aggregateSha256);
  });

  test("rejects source corruption, unverified rows, and mismatched restore acknowledgements", async () => {
    const snapshot = canonicalSnapshot();
    const corrupt = snapshot.bytes.slice();
    corrupt[10] ^= 1;
    const captureDependencies: AgentSnapshotV2CloudDependencies = {
      fetch,
      readStored: () => replay(snapshot.bytes),
      storage: {
        async create(params) {
          const staged = await collect(params.source);
          await params.verify(replay(staged));
          return storedBackup(snapshot.aggregateSha256);
        },
      },
    };
    await expect(
      captureAgentSnapshotV2({
        agentId: AGENT_ID,
        dependencies: captureDependencies,
        organizationId: ORGANIZATION_ID,
        response: new Response(corrupt, {
          headers: { "Content-Type": AGENT_SNAPSHOT_V2_CONTENT_TYPE },
        }),
        sandboxRecordId: SANDBOX_RECORD_ID,
      }),
    ).rejects.toThrow();

    const unverified = storedBackup(snapshot.aggregateSha256);
    unverified.verification_status = "pending";
    await expect(
      restoreAgentSnapshotV2({
        agentId: AGENT_ID,
        backup: unverified,
        dependencies: captureDependencies,
        endpoint: "https://agent.example/api/restore?transfer=chunked-v1",
        headers: {},
        organizationId: ORGANIZATION_ID,
      }),
    ).rejects.toThrow("is not a verified restore point");

    const mismatchFetch: typeof fetch = async (_input, init) => {
      if (!(init?.body instanceof ReadableStream)) {
        throw new Error("restore request body is not a stream");
      }
      await new Response(init.body).arrayBuffer();
      return new Response(
        JSON.stringify({
          aggregateSha256: "ef".repeat(32),
          fileCount: 0,
          requiresRestart: true,
          schemaVersion: 2,
          success: true,
          totalBytes: 0,
          transfer: "chunked-v1",
        }),
      );
    };
    await expect(
      restoreAgentSnapshotV2({
        agentId: AGENT_ID,
        backup: storedBackup(snapshot.aggregateSha256),
        dependencies: { ...captureDependencies, fetch: mismatchFetch },
        endpoint: "https://agent.example/api/restore?transfer=chunked-v1",
        headers: {},
        organizationId: ORGANIZATION_ID,
      }),
    ).rejects.toThrow("acknowledgement does not match");
  });

  test("cancels an agent response when validation rejects before EOF", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const dependencies: AgentSnapshotV2CloudDependencies = {
      fetch,
      readStored: () => replay(new Uint8Array()),
      storage: {
        async create(params) {
          await collect(params.source);
          throw new Error("unreachable");
        },
      },
    };

    await expect(
      captureAgentSnapshotV2({
        agentId: AGENT_ID,
        dependencies,
        organizationId: ORGANIZATION_ID,
        response: new Response(body, {
          headers: { "Content-Type": AGENT_SNAPSHOT_V2_CONTENT_TYPE },
        }),
        sandboxRecordId: SANDBOX_RECORD_ID,
      }),
    ).rejects.toThrow("Snapshot stream descriptor");
    expect(cancelled).toBe(true);
  });

  test("cancels an unread agent response when storage rejects before consuming it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const dependencies: AgentSnapshotV2CloudDependencies = {
      fetch,
      readStored: () => replay(new Uint8Array()),
      storage: {
        async create() {
          throw new Error("injected storage refusal");
        },
      },
    };

    await expect(
      captureAgentSnapshotV2({
        agentId: AGENT_ID,
        dependencies,
        organizationId: ORGANIZATION_ID,
        response: new Response(body, {
          headers: { "Content-Type": AGENT_SNAPSHOT_V2_CONTENT_TYPE },
        }),
        sandboxRecordId: SANDBOX_RECORD_ID,
      }),
    ).rejects.toThrow("injected storage refusal");
    expect(cancelled).toBe(true);
  });

  test("aborts readStored initialization that never settles", async () => {
    const snapshot = canonicalSnapshot();
    let observedSignal: AbortSignal | undefined;
    const dependencies: AgentSnapshotV2CloudDependencies = {
      fetch,
      readStored: ({ signal }) => {
        observedSignal = signal;
        return new Promise<AsyncIterable<Uint8Array>>(() => undefined);
      },
      restoreTimeouts: {
        baseMs: 100,
        idleMs: 15,
        minBytesPerSecond: 1024 * 1024,
      },
      storage: {
        async create() {
          throw new Error("restore must not create a backup");
        },
      },
    };

    await expect(
      restoreAgentSnapshotV2({
        agentId: AGENT_ID,
        backup: storedBackup(snapshot.aggregateSha256),
        dependencies,
        endpoint: "https://agent.example/api/restore?transfer=chunked-v1",
        headers: {},
        organizationId: ORGANIZATION_ID,
      }),
    ).rejects.toThrow("Snapshot v2 restore timed out");
    expect(observedSignal?.aborted).toBe(true);
  });

  test("aborts a stored iterator next call that never settles", async () => {
    const snapshot = canonicalSnapshot();
    let sourceReturned = false;
    const stalledSource: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          async return() {
            sourceReturned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const timeoutFetch: typeof fetch = async (_input, init) => {
      if (!(init?.body instanceof ReadableStream) || !init.signal) {
        throw new Error("restore request must carry a cancellable stream");
      }
      const reader = init.body.getReader();
      void reader.read().catch(() => undefined);
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => {
            void reader.cancel(init.signal?.reason).catch(() => undefined);
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });
    };
    const dependencies: AgentSnapshotV2CloudDependencies = {
      fetch: timeoutFetch,
      readStored: () => stalledSource,
      restoreTimeouts: {
        baseMs: 100,
        idleMs: 15,
        minBytesPerSecond: 1024 * 1024,
      },
      storage: {
        async create() {
          throw new Error("restore must not create a backup");
        },
      },
    };

    await expect(
      restoreAgentSnapshotV2({
        agentId: AGENT_ID,
        backup: storedBackup(snapshot.aggregateSha256),
        dependencies,
        endpoint: "https://agent.example/api/restore?transfer=chunked-v1",
        headers: {},
        organizationId: ORGANIZATION_ID,
      }),
    ).rejects.toThrow("Snapshot v2 restore timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sourceReturned).toBe(true);
  });

  test("scales its absolute restore budget and aborts an idle stored stream", async () => {
    expect(
      agentSnapshotV2RestoreTimeoutMs(512 * 1024 * 1024, {
        baseMs: 1_000,
        idleMs: 50,
        minBytesPerSecond: 1024 * 1024,
      }),
    ).toBe(513_000);

    const snapshot = canonicalSnapshot();
    let sourceReturned = false;
    async function* stalledSource(): AsyncGenerator<Uint8Array> {
      try {
        yield snapshot.bytes.subarray(0, 1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield snapshot.bytes.subarray(1);
      } finally {
        sourceReturned = true;
      }
    }
    const timeoutFetch: typeof fetch = async (_input, init) => {
      if (!(init?.body instanceof ReadableStream) || !init.signal) {
        throw new Error("restore request must carry a cancellable stream");
      }
      const reader = init.body.getReader();
      await reader.read();
      await new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => {
            void reader.cancel(init.signal?.reason).then(
              () => reject(init.signal?.reason),
              (error) => reject(error),
            );
          },
          { once: true },
        );
      });
    };
    const dependencies: AgentSnapshotV2CloudDependencies = {
      fetch: timeoutFetch,
      readStored: () => stalledSource(),
      restoreTimeouts: {
        baseMs: 100,
        idleMs: 20,
        minBytesPerSecond: 1024 * 1024,
      },
      storage: {
        async create() {
          throw new Error("restore must not create a backup");
        },
      },
    };

    await expect(
      restoreAgentSnapshotV2({
        agentId: AGENT_ID,
        backup: storedBackup(snapshot.aggregateSha256),
        dependencies,
        endpoint: "https://agent.example/api/restore?transfer=chunked-v1",
        headers: {},
        organizationId: ORGANIZATION_ID,
      }),
    ).rejects.toThrow("Snapshot v2 restore timed out");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sourceReturned).toBe(true);
  });
});
