/**
 * Exercises the real capture-v2 producer and shared decoder with deterministic
 * streaming sources. The 10 MiB and 128 MiB cases move every byte through both
 * boundaries while sampling RSS; the 1 GiB proof is explicitly nightly-gated.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  type AgentBackupCaptureV2Request,
  type AgentBackupCaptureV2Sha256Digest,
  type AgentBackupCaptureV2Sha256StreamFactory,
  type AgentBackupRecordStreamV1Record,
  parseAgentBackupCaptureV2Frames,
  parseAgentBackupRecordStreamV1,
  serializeAgentBackupRecordStreamV1Magic,
  serializeAgentBackupRecordStreamV1Record,
} from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_BACKUP_V2_PGLITE_CAPTURE_LIMITS,
  type AgentBackupV2CaptureComponentSource,
  type AgentBackupV2CaptureSourceChunk,
  createDefaultAgentBackupV2CaptureSources,
  streamAgentBackupV2Capture,
} from "./agent-backup-v2-capture.ts";

const MIB = 1024 * 1024;
const ids = {
  operation: "11111111-1111-4111-8111-111111111111",
  agent: "22222222-2222-4222-8222-222222222222",
  activation: "33333333-3333-4333-8333-333333333333",
};

const nodeDigest: AgentBackupCaptureV2Sha256Digest = (bytes) =>
  createHash("sha256").update(bytes).digest();

const nodeStreamFactory: AgentBackupCaptureV2Sha256StreamFactory = () => {
  const hash = createHash("sha256");
  return {
    update(bytes) {
      hash.update(bytes);
    },
    digestHex() {
      return hash.digest("hex");
    },
  };
};

function request(deadlineMs = 120_000): AgentBackupCaptureV2Request {
  return {
    format: AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    operationId: ids.operation,
    agentId: ids.agent,
    activationGeneration: ids.activation,
    lifecycleRevision: "73",
    deadlineEpochMs: Date.now() + deadlineMs,
  };
}

function syntheticSource(
  totalBytes: number,
  options: { name?: string; byte?: number } = {},
): AgentBackupV2CaptureComponentSource {
  const chunk = Buffer.alloc(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
    options.byte ?? 0x5a,
  );
  return {
    descriptor: {
      name: options.name ?? "database",
      format: "synthetic-v1",
      compression: "none",
      contentKind: "opaque",
      consistency: "transactional",
    },
    async *open(signal) {
      let remaining = totalBytes;
      while (remaining > 0) {
        if (signal.aborted) throw signal.reason;
        const length = Math.min(remaining, chunk.length);
        yield { bytes: chunk.subarray(0, length) };
        remaining -= length;
      }
    },
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

interface CapturedDefaultDataFrame {
  componentName: string;
  entryPath: string | null;
  bytes: Uint8Array;
}

function managedPgliteAdapter(
  dataDir: string,
  dump: Blob,
  release: () => void = vi.fn(),
) {
  return {
    dumpPgliteDataDirAfterPreflight: vi.fn(
      async <T>(preflight: () => Promise<T>) => ({
        dump,
        preflight: await preflight(),
        release,
      }),
    ),
    getPgliteDataDir: vi.fn(() => dataDir),
  };
}

function mockCaptureAvailableMemory(bytes = 512 * MIB): void {
  vi.spyOn(process, "availableMemory").mockReturnValue(bytes);
}

async function waitForAssertion(
  assertion: () => void,
  maxAttempts = 1_000,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw lastError;
}

async function captureDefaultDataFrames(
  databasePayload: BlobPart = "managed-pglite-dump",
): Promise<readonly CapturedDefaultDataFrame[]> {
  const pgliteDir = process.env.PGLITE_DATA_DIR;
  if (!pgliteDir) throw new Error("PGLITE_DATA_DIR is required by this test");
  const components = createDefaultAgentBackupV2CaptureSources(
    {
      agentId: ids.agent,
      character: null,
      adapter: managedPgliteAdapter(pgliteDir, new Blob([databasePayload])),
      getSetting: () => undefined,
    },
    {},
  );
  const frames: CapturedDefaultDataFrame[] = [];
  for await (const frame of parseAgentBackupCaptureV2Frames(
    streamAgentBackupV2Capture({
      request: request(),
      agentId: ids.agent,
      components,
    }),
    { digest: nodeDigest, sha256StreamFactory: nodeStreamFactory },
  )) {
    if (frame.header.kind !== "data") continue;
    frames.push({
      componentName: frame.header.componentName,
      entryPath: frame.header.entry?.path ?? null,
      bytes: frame.payload,
    });
  }
  return frames;
}

function restoreEnvironmentValue(
  name: "DATABASE_URL" | "ELIZA_STATE_DIR" | "PGLITE_DATA_DIR" | "POSTGRES_URL",
  previous: string | undefined,
): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

async function consumeSyntheticCapture(totalBytes: number): Promise<{
  payloadBytes: number;
  dataFrames: number;
  peakRssDelta: number;
  lifecycleRevision: string;
  activationGeneration: string;
}> {
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  let payloadBytes = 0;
  let dataFrames = 0;
  let lifecycleRevision = "";
  let activationGeneration = "";
  const capture = streamAgentBackupV2Capture({
    request: request(10 * 60_000),
    agentId: ids.agent,
    components: [syntheticSource(totalBytes)],
  });
  for await (const frame of parseAgentBackupCaptureV2Frames(capture, {
    digest: nodeDigest,
    sha256StreamFactory: nodeStreamFactory,
  })) {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (frame.header.kind === "capture-start") {
      lifecycleRevision = frame.header.lifecycleRevision;
      activationGeneration = frame.header.activationGeneration;
    }
    if (frame.header.kind === "data") {
      payloadBytes += frame.payload.length;
      dataFrames += 1;
      expect(frame.payload.length).toBeLessThanOrEqual(
        AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
      );
    }
  }
  return {
    payloadBytes,
    dataFrames,
    peakRssDelta: Math.max(0, peakRss - baselineRss),
    lifecycleRevision,
    activationGeneration,
  };
}

describe("streamAgentBackupV2Capture", () => {
  it("streams a real synthetic 10 MiB capture with bounded RSS", async () => {
    const result = await consumeSyntheticCapture(10 * MIB);

    expect(result.payloadBytes).toBe(10 * MIB);
    expect(result.dataFrames).toBe(40);
    expect(result.peakRssDelta).toBeLessThan(64 * MIB);
    expect(result.lifecycleRevision).toBe("73");
    expect(result.activationGeneration).toBe(ids.activation);
  }, 60_000);

  it("streams a real synthetic 128 MiB capture under a fixed RSS ceiling", async () => {
    const result = await consumeSyntheticCapture(128 * MIB);

    expect(result.payloadBytes).toBe(128 * MIB);
    expect(result.dataFrames).toBe(512);
    expect(result.peakRssDelta).toBeLessThan(224 * MIB);
  }, 120_000);

  it.skipIf(process.env.AGENT_BACKUP_V2_NIGHTLY_1_GIB !== "1")(
    "streams the nightly 1 GiB capture under a fixed RSS ceiling",
    async () => {
      const result = await consumeSyntheticCapture(1024 * MIB);

      expect(result.payloadBytes).toBe(1024 * MIB);
      expect(result.dataFrames).toBe(4_096);
      expect(result.peakRssDelta).toBeLessThan(320 * MIB);
    },
    10 * 60_000,
  );

  it("opens and drains components strictly one at a time", async () => {
    const events: string[] = [];
    const source = (name: string): AgentBackupV2CaptureComponentSource => ({
      descriptor: {
        name,
        format: "synthetic-v1",
        compression: "none",
        contentKind: "opaque",
        consistency: "transactional",
      },
      async *open() {
        events.push(`${name}:open`);
        yield { bytes: Uint8Array.of(1) };
        events.push(`${name}:done`);
      },
    });
    const capture = streamAgentBackupV2Capture({
      request: request(),
      agentId: ids.agent,
      components: [source("character"), source("database")],
    });

    for await (const _wireFrame of capture) {
      // Fully consume the producer; events prove no eager second source open.
    }
    expect(events).toEqual([
      "character:open",
      "character:done",
      "database:open",
      "database:done",
    ]);
  });

  it("streams the managed PGlite Blob without calling arrayBuffer", async () => {
    mockCaptureAvailableMemory();
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-backup-managed-pglite-"),
    );
    const stateDir = path.join(root, "state");
    const pgliteDir = path.join(stateDir, ".pgdata");
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousPgliteDir = process.env.PGLITE_DATA_DIR;
    const previousPostgresUrl = process.env.POSTGRES_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    await fs.promises.mkdir(pgliteDir, { recursive: true });
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    const payload = Buffer.alloc(2 * MIB, 0x33);
    await fs.promises.writeFile(path.join(pgliteDir, "base.dat"), payload);
    const dump = new Blob([payload]);
    const arrayBuffer = vi
      .spyOn(dump, "arrayBuffer")
      .mockRejectedValue(new Error("arrayBuffer must not be called"));
    const release = vi.fn();
    try {
      const adapter = managedPgliteAdapter(pgliteDir, dump, release);
      const streamDatabase = async () => {
        const database = createDefaultAgentBackupV2CaptureSources(
          {
            agentId: ids.agent,
            adapter,
            getSetting: () => undefined,
          },
          {},
        ).find((candidate) => candidate.descriptor.name === "database");
        if (!database) throw new Error("database source missing");
        let streamedBytes = 0;
        for await (const chunk of database.open(new AbortController().signal)) {
          streamedBytes += chunk.bytes.length;
        }
        return streamedBytes;
      };

      await expect(streamDatabase()).resolves.toBe(payload.length);
      await expect(streamDatabase()).resolves.toBe(payload.length);
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(adapter.dumpPgliteDataDirAfterPreflight).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
      else process.env.ELIZA_STATE_DIR = previousStateDir;
      if (previousPgliteDir === undefined) delete process.env.PGLITE_DATA_DIR;
      else process.env.PGLITE_DATA_DIR = previousPgliteDir;
      if (previousPostgresUrl === undefined) delete process.env.POSTGRES_URL;
      else process.env.POSTGRES_URL = previousPostgresUrl;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("captures and restores a real filesystem-backed PGlite producer", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-backup-real-pglite-"),
    );
    const stateDir = path.join(root, "state");
    const pgliteDir = path.join(stateDir, ".pgdata");
    const restoredDir = path.join(root, "restored");
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousPgliteDir = process.env.PGLITE_DATA_DIR;
    const previousPostgresUrl = process.env.POSTGRES_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousDisableExtensions =
      process.env.ELIZA_PGLITE_DISABLE_EXTENSIONS;
    const availableMemory = vi
      .spyOn(process, "availableMemory")
      .mockReturnValue(512 * MIB);
    type RealPgliteAdapter = ReturnType<typeof createDatabaseAdapter> & {
      getRawConnection(): PGlite;
      getPgliteDataDir(): string | null;
      dumpPgliteDataDirAfterPreflight<T>(
        preflight: () => Promise<T>,
        compression?: "gzip",
      ): Promise<{ dump: File | Blob; preflight: T; release: () => void }>;
      close(): Promise<void>;
    };
    let adapter: RealPgliteAdapter | undefined;
    let restored: PGlite | undefined;
    try {
      await fs.promises.mkdir(stateDir, { recursive: true });
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.PGLITE_DATA_DIR = pgliteDir;
      process.env.ELIZA_PGLITE_DISABLE_EXTENSIONS = "1";
      delete process.env.POSTGRES_URL;
      delete process.env.DATABASE_URL;
      adapter = createDatabaseAdapter(
        { dataDir: pgliteDir },
        ids.agent,
      ) as RealPgliteAdapter;

      const source = adapter.getRawConnection();
      await source.waitReady;
      await source.exec(
        "CREATE TABLE capture_e2e (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO capture_e2e VALUES (7, 'real-pglite');",
      );

      const components = createDefaultAgentBackupV2CaptureSources(
        {
          agentId: ids.agent,
          character: null,
          adapter,
          getSetting: () => undefined,
        },
        {},
      );
      const databaseParts: Uint8Array[] = [];
      for await (const frame of parseAgentBackupCaptureV2Frames(
        streamAgentBackupV2Capture({
          request: request(),
          agentId: ids.agent,
          components,
        }),
        { digest: nodeDigest, sha256StreamFactory: nodeStreamFactory },
      )) {
        if (
          frame.header.kind === "data" &&
          frame.header.componentName === "database"
        ) {
          databaseParts.push(frame.payload.slice());
        }
      }
      expect(databaseParts.length).toBeGreaterThan(0);

      restored = new PGlite({
        dataDir: restoredDir,
        loadDataDir: new Blob([new Uint8Array(concat(databaseParts))]),
      });
      await restored.waitReady;
      const restoredRows = await restored.query<{ id: number; value: string }>(
        "SELECT id, value FROM capture_e2e",
      );
      expect(restoredRows.rows).toEqual([{ id: 7, value: "real-pglite" }]);
    } finally {
      await restored?.close();
      await adapter?.close();
      availableMemory.mockRestore();
      restoreEnvironmentValue("ELIZA_STATE_DIR", previousStateDir);
      restoreEnvironmentValue("PGLITE_DATA_DIR", previousPgliteDir);
      restoreEnvironmentValue("POSTGRES_URL", previousPostgresUrl);
      restoreEnvironmentValue("DATABASE_URL", previousDatabaseUrl);
      if (previousDisableExtensions === undefined)
        delete process.env.ELIZA_PGLITE_DISABLE_EXTENSIONS;
      else
        process.env.ELIZA_PGLITE_DISABLE_EXTENSIONS = previousDisableExtensions;
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails closed without the fenced managed exporter and never falls back to live files", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-backup-missing-managed-dump-"),
    );
    const stateDir = path.join(root, "state");
    const pgliteDir = path.join(stateDir, ".pgdata");
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousPgliteDir = process.env.PGLITE_DATA_DIR;
    const previousPostgresUrl = process.env.POSTGRES_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const legacyDump = vi.fn(async () => new Blob(["legacy"]));
    try {
      await fs.promises.mkdir(pgliteDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(pgliteDir, "PG_VERSION"),
        "live-file-must-not-be-captured",
      );
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.PGLITE_DATA_DIR = pgliteDir;
      delete process.env.POSTGRES_URL;
      delete process.env.DATABASE_URL;

      expect(() =>
        createDefaultAgentBackupV2CaptureSources(
          {
            agentId: ids.agent,
            adapter: {
              dumpPgliteDataDir: legacyDump,
              getPgliteDataDir: () => pgliteDir,
            },
            getSetting: () => undefined,
          },
          {},
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "AGENT_BACKUP_V2_PGLITE_MANAGED_DUMP_UNAVAILABLE",
        }),
      );
      expect(legacyDump).not.toHaveBeenCalled();
    } finally {
      restoreEnvironmentValue("ELIZA_STATE_DIR", previousStateDir);
      restoreEnvironmentValue("PGLITE_DATA_DIR", previousPgliteDir);
      restoreEnvironmentValue("POSTGRES_URL", previousPostgresUrl);
      restoreEnvironmentValue("DATABASE_URL", previousDatabaseUrl);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an over-limit physical PGlite directory before materialization", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-backup-over-limit-pglite-"),
    );
    const stateDir = path.join(root, "state");
    const pgliteDir = path.join(stateDir, ".pgdata");
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousPgliteDir = process.env.PGLITE_DATA_DIR;
    const previousPostgresUrl = process.env.POSTGRES_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const materialize = vi.fn(async () => new Blob(["must-not-run"]));
    try {
      await fs.promises.mkdir(pgliteDir, { recursive: true });
      await fs.promises.writeFile(path.join(pgliteDir, "oversized.dat"), "");
      await fs.promises.truncate(
        path.join(pgliteDir, "oversized.dat"),
        AGENT_BACKUP_V2_PGLITE_CAPTURE_LIMITS.maxPhysicalBytes + 1,
      );
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.PGLITE_DATA_DIR = pgliteDir;
      delete process.env.POSTGRES_URL;
      delete process.env.DATABASE_URL;

      const database = createDefaultAgentBackupV2CaptureSources(
        {
          agentId: ids.agent,
          adapter: {
            dumpPgliteDataDirAfterPreflight: async <T>(
              preflight: () => Promise<T>,
            ) => {
              const preflightResult = await preflight();
              return {
                dump: await materialize(),
                preflight: preflightResult,
                release: vi.fn(),
              };
            },
            getPgliteDataDir: () => pgliteDir,
          },
          getSetting: () => undefined,
        },
        {},
      ).find((source) => source.descriptor.name === "database");
      if (!database) throw new Error("database capture source missing");

      await expect(
        database
          .open(new AbortController().signal)
          [Symbol.asyncIterator]()
          .next(),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
      });
      expect(materialize).not.toHaveBeenCalled();
    } finally {
      restoreEnvironmentValue("ELIZA_STATE_DIR", previousStateDir);
      restoreEnvironmentValue("PGLITE_DATA_DIR", previousPgliteDir);
      restoreEnvironmentValue("POSTGRES_URL", previousPostgresUrl);
      restoreEnvironmentValue("DATABASE_URL", previousDatabaseUrl);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects when available memory leaves no conservative dump budget", async () => {
    mockCaptureAvailableMemory(
      AGENT_BACKUP_V2_PGLITE_CAPTURE_LIMITS.availableMemoryHeadroomBytes,
    );
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-backup-rss-budget-pglite-"),
    );
    const stateDir = path.join(root, "state");
    const pgliteDir = path.join(stateDir, ".pgdata");
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousPgliteDir = process.env.PGLITE_DATA_DIR;
    const previousPostgresUrl = process.env.POSTGRES_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const materialize = vi.fn(async () => new Blob(["must-not-run"]));
    try {
      await fs.promises.mkdir(pgliteDir, { recursive: true });
      await fs.promises.writeFile(path.join(pgliteDir, "PG_VERSION"), "17");
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.PGLITE_DATA_DIR = pgliteDir;
      delete process.env.POSTGRES_URL;
      delete process.env.DATABASE_URL;

      const database = createDefaultAgentBackupV2CaptureSources(
        {
          agentId: ids.agent,
          adapter: {
            dumpPgliteDataDirAfterPreflight: async <T>(
              preflight: () => Promise<T>,
            ) => {
              const preflightResult = await preflight();
              return {
                dump: await materialize(),
                preflight: preflightResult,
                release: vi.fn(),
              };
            },
            getPgliteDataDir: () => pgliteDir,
          },
          getSetting: () => undefined,
        },
        {},
      ).find((source) => source.descriptor.name === "database");
      if (!database) throw new Error("database capture source missing");

      await expect(
        database
          .open(new AbortController().signal)
          [Symbol.asyncIterator]()
          .next(),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_PGLITE_RSS_BUDGET_EXCEEDED",
      });
      expect(materialize).not.toHaveBeenCalled();
    } finally {
      restoreEnvironmentValue("ELIZA_STATE_DIR", previousStateDir);
      restoreEnvironmentValue("PGLITE_DATA_DIR", previousPgliteDir);
      restoreEnvironmentValue("POSTGRES_URL", previousPostgresUrl);
      restoreEnvironmentValue("DATABASE_URL", previousDatabaseUrl);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an aborted uncancellable dump busy until it settles", async () => {
    mockCaptureAvailableMemory();
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-backup-late-pglite-dump-"),
    );
    const stateDir = path.join(root, "state");
    const pgliteDir = path.join(stateDir, ".pgdata");
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousPgliteDir = process.env.PGLITE_DATA_DIR;
    const previousPostgresUrl = process.env.POSTGRES_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    let releaseDump!: (dump: Blob) => void;
    const materialize = vi.fn(
      async () =>
        await new Promise<Blob>((resolve) => {
          releaseDump = resolve;
        }),
    );
    const releaseLease = vi.fn();
    const adapter = {
      dumpPgliteDataDirAfterPreflight: async <T>(
        preflight: () => Promise<T>,
      ) => {
        const preflightResult = await preflight();
        return {
          dump: await materialize(),
          preflight: preflightResult,
          release: releaseLease,
        };
      },
      getPgliteDataDir: () => pgliteDir,
    };
    try {
      await fs.promises.mkdir(pgliteDir, { recursive: true });
      await fs.promises.writeFile(path.join(pgliteDir, "PG_VERSION"), "17");
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.PGLITE_DATA_DIR = pgliteDir;
      delete process.env.POSTGRES_URL;
      delete process.env.DATABASE_URL;

      const createDatabaseSource = () => {
        const source = createDefaultAgentBackupV2CaptureSources(
          {
            agentId: ids.agent,
            adapter,
            getSetting: () => undefined,
          },
          {},
        ).find((candidate) => candidate.descriptor.name === "database");
        if (!source) throw new Error("database capture source missing");
        return source;
      };

      const firstController = new AbortController();
      const firstIterator = createDatabaseSource()
        .open(firstController.signal)
        [Symbol.asyncIterator]();
      const firstNext = firstIterator.next();
      await waitForAssertion(() =>
        expect(materialize).toHaveBeenCalledTimes(1),
      );
      firstController.abort(new Error("client disconnected"));

      await expect(
        createDatabaseSource()
          .open(new AbortController().signal)
          [Symbol.asyncIterator]()
          .next(),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_PGLITE_DUMP_BUSY",
      });
      expect(materialize).toHaveBeenCalledTimes(1);

      releaseDump(new Blob(["late-dump"]));
      await expect(firstNext).rejects.toThrow("client disconnected");
      expect(materialize).toHaveBeenCalledTimes(1);
      expect(releaseLease).toHaveBeenCalledTimes(1);
    } finally {
      restoreEnvironmentValue("ELIZA_STATE_DIR", previousStateDir);
      restoreEnvironmentValue("PGLITE_DATA_DIR", previousPgliteDir);
      restoreEnvironmentValue("POSTGRES_URL", previousPostgresUrl);
      restoreEnvironmentValue("DATABASE_URL", previousDatabaseUrl);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an aborted stalled Blob reader busy until source cleanup settles", async () => {
    mockCaptureAvailableMemory();
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-backup-stalled-pglite-reader-"),
    );
    const stateDir = path.join(root, "state");
    const pgliteDir = path.join(stateDir, ".pgdata");
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousPgliteDir = process.env.PGLITE_DATA_DIR;
    const previousPostgresUrl = process.env.POSTGRES_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    let releaseRead!: (result: ReadableStreamReadResult<Uint8Array>) => void;
    const stalledRead = new Promise<ReadableStreamReadResult<Uint8Array>>(
      (resolve) => {
        releaseRead = resolve;
      },
    );
    let readCount = 0;
    const reader = {
      cancel: vi.fn(async () => await new Promise<void>(() => undefined)),
      read: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) {
          return { done: false as const, value: Uint8Array.of(0x41) };
        }
        return await stalledRead;
      }),
      releaseLock: vi.fn(),
    };
    const stalledDump = {
      size: 1,
      stream: () => ({ getReader: () => reader }),
    };
    const materialize = vi
      .fn<() => typeof stalledDump | Blob>()
      .mockReturnValueOnce(stalledDump)
      .mockReturnValue(new Blob(["released"]));
    const releaseLease = vi.fn();
    const adapter = {
      dumpPgliteDataDirAfterPreflight: async <T>(
        preflight: () => Promise<T>,
      ) => {
        const preflightResult = await preflight();
        return {
          dump: materialize(),
          preflight: preflightResult,
          release: releaseLease,
        };
      },
      getPgliteDataDir: () => pgliteDir,
    };
    try {
      await fs.promises.mkdir(pgliteDir, { recursive: true });
      await fs.promises.writeFile(path.join(pgliteDir, "PG_VERSION"), "17");
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.PGLITE_DATA_DIR = pgliteDir;
      delete process.env.POSTGRES_URL;
      delete process.env.DATABASE_URL;

      const createDatabaseSource = () => {
        const source = createDefaultAgentBackupV2CaptureSources(
          {
            agentId: ids.agent,
            adapter,
            getSetting: () => undefined,
          },
          {},
        ).find((candidate) => candidate.descriptor.name === "database");
        if (!source) throw new Error("database capture source missing");
        return source;
      };
      const controller = new AbortController();
      const capture = streamAgentBackupV2Capture({
        request: request(),
        agentId: ids.agent,
        components: [createDatabaseSource()],
        signal: controller.signal,
      })[Symbol.asyncIterator]();

      await capture.next();
      await capture.next();
      await capture.next();
      const stalledFrame = capture.next();
      await waitForAssertion(() =>
        expect(reader.read).toHaveBeenCalledTimes(2),
      );
      controller.abort(new Error("client disconnected"));
      await expect(stalledFrame).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_CAPTURE_ABORTED",
      });

      await expect(
        createDatabaseSource()
          .open(new AbortController().signal)
          [Symbol.asyncIterator]()
          .next(),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_PGLITE_DUMP_BUSY",
      });
      expect(materialize).toHaveBeenCalledTimes(1);

      releaseRead({ done: true, value: undefined });
      await waitForAssertion(() =>
        expect(reader.releaseLock).toHaveBeenCalledTimes(1),
      );
      expect(releaseLease).toHaveBeenCalledTimes(1);

      const third = createDatabaseSource()
        .open(new AbortController().signal)
        [Symbol.asyncIterator]();
      await expect(third.next()).resolves.toMatchObject({ done: false });
      await expect(third.return?.()).resolves.toMatchObject({ done: true });
      expect(materialize).toHaveBeenCalledTimes(2);
      expect(releaseLease).toHaveBeenCalledTimes(2);
    } finally {
      restoreEnvironmentValue("ELIZA_STATE_DIR", previousStateDir);
      restoreEnvironmentValue("PGLITE_DATA_DIR", previousPgliteDir);
      restoreEnvironmentValue("POSTGRES_URL", previousPostgresUrl);
      restoreEnvironmentValue("DATABASE_URL", previousDatabaseUrl);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("orders real state-file capture exactly as the canonical record codec requires", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-backup-path-order-"),
    );
    const pglite = path.join(root, "pglite");
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousPgliteDir = process.env.PGLITE_DATA_DIR;
    const previousPostgresUrl = process.env.POSTGRES_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pglite;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    try {
      await fs.promises.mkdir(pglite, { recursive: true });
      await fs.promises.mkdir(path.join(root, "a"), { recursive: true });
      for (const [relativePath, value] of [
        ["a-plain", "hyphen"],
        ["a/nested", "nested"],
        ["B", "uppercase"],
        ["file_1", "underscore"],
        ["file-2", "dash"],
        ["ä", "non-ascii"],
        ["z", "last-ascii"],
      ] as const) {
        await fs.promises.writeFile(path.join(root, relativePath), value);
      }
      const stateFiles = createDefaultAgentBackupV2CaptureSources(
        {
          agentId: ids.agent,
          character: null,
          adapter: managedPgliteAdapter(pglite, new Blob(["database"])),
          getSetting: () => undefined,
        },
        {},
      ).find((source) => source.descriptor.name === "state-files");
      if (!stateFiles) throw new Error("state-files capture source missing");

      const recordParts: Uint8Array[] = [];
      const capture = parseAgentBackupCaptureV2Frames(
        streamAgentBackupV2Capture({
          request: request(),
          agentId: ids.agent,
          components: [stateFiles],
        }),
        { digest: nodeDigest, sha256StreamFactory: nodeStreamFactory },
      );
      for await (const captured of capture) {
        if (captured.header.kind === "component-start") {
          recordParts.push(
            serializeAgentBackupRecordStreamV1Magic(),
            ...serializeAgentBackupRecordStreamV1Record({
              kind: "component-start",
              descriptor: captured.header.component,
            }),
          );
        } else if (captured.header.kind === "data") {
          recordParts.push(
            ...serializeAgentBackupRecordStreamV1Record({
              kind: "data",
              dataIndex: captured.header.dataIndex,
              offsetBytes: captured.header.offsetBytes,
              payloadBytes: captured.header.payloadBytes,
              entry: captured.header.entry ?? null,
              payload: captured.payload,
            }),
          );
        } else if (captured.header.kind === "component-end") {
          recordParts.push(
            ...serializeAgentBackupRecordStreamV1Record({
              kind: "component-end",
              dataFrameCount: captured.header.dataFrameCount,
              payloadBytes: captured.header.plainBytes,
              payloadSha256: captured.header.payloadSha256,
            }),
          );
        }
      }

      const wire = concat(recordParts);
      const source = (async function* () {
        for (let offset = 0; offset < wire.byteLength; offset += 17) {
          yield wire.slice(offset, Math.min(offset + 17, wire.byteLength));
        }
      })();
      const records: AgentBackupRecordStreamV1Record[] = [];
      for await (const record of parseAgentBackupRecordStreamV1(source, {
        sha256StreamFactory: nodeStreamFactory,
      })) {
        records.push(record);
      }
      expect(
        records
          .filter((record) => record.kind === "data")
          .map((record) => record.entry?.path),
      ).toEqual(["B", "a-plain", "a/nested", "file-2", "file_1", "z", "ä"]);
    } finally {
      if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
      else process.env.ELIZA_STATE_DIR = previousStateDir;
      if (previousPgliteDir === undefined) delete process.env.PGLITE_DATA_DIR;
      else process.env.PGLITE_DATA_DIR = previousPgliteDir;
      if (previousPostgresUrl === undefined) delete process.env.POSTGRES_URL;
      else process.env.POSTGRES_URL = previousPostgresUrl;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("captures cloud-style .pgdata bytes only in the database component", async () => {
    mockCaptureAvailableMemory();
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-backup-pgdata-disjoint-"),
    );
    const stateDir = path.join(root, "state");
    const pgliteDir = path.join(stateDir, ".pgdata");
    const databaseMarker = "database-only-managed-pgdata";
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousPgliteDir = process.env.PGLITE_DATA_DIR;
    const previousPostgresUrl = process.env.POSTGRES_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    try {
      await fs.promises.mkdir(pgliteDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(pgliteDir, "PG_VERSION"),
        databaseMarker,
      );
      await fs.promises.writeFile(path.join(stateDir, "settings.json"), "{}");
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.PGLITE_DATA_DIR = pgliteDir;
      delete process.env.POSTGRES_URL;
      delete process.env.DATABASE_URL;

      const frames = await captureDefaultDataFrames(databaseMarker);
      const markerComponents = frames
        .filter(
          (frame) => Buffer.from(frame.bytes).toString() === databaseMarker,
        )
        .map((frame) => frame.componentName);
      const statePaths = frames
        .filter((frame) => frame.componentName === "state-files")
        .map((frame) => frame.entryPath);

      expect(markerComponents).toEqual(["database"]);
      expect(statePaths).toContain("settings.json");
      expect(statePaths).not.toContain(".pgdata/PG_VERSION");
    } finally {
      restoreEnvironmentValue("ELIZA_STATE_DIR", previousStateDir);
      restoreEnvironmentValue("PGLITE_DATA_DIR", previousPgliteDir);
      restoreEnvironmentValue("POSTGRES_URL", previousPostgresUrl);
      restoreEnvironmentValue("DATABASE_URL", previousDatabaseUrl);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("excludes a custom relative PGlite subtree without pruning sibling state", async () => {
    mockCaptureAvailableMemory();
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-backup-relative-pgdata-"),
    );
    const stateDir = path.join(root, "state");
    const pgliteDir = path.join(stateDir, "custom", "database");
    const databaseMarker = "database-only-relative-path";
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousPgliteDir = process.env.PGLITE_DATA_DIR;
    const previousPostgresUrl = process.env.POSTGRES_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    try {
      await fs.promises.mkdir(pgliteDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(pgliteDir, "PG_VERSION"),
        databaseMarker,
      );
      await fs.promises.writeFile(
        path.join(stateDir, "custom", "keep.json"),
        "{}",
      );
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.PGLITE_DATA_DIR = path.relative(process.cwd(), pgliteDir);
      delete process.env.POSTGRES_URL;
      delete process.env.DATABASE_URL;

      const frames = await captureDefaultDataFrames(databaseMarker);
      const markerComponents = frames
        .filter(
          (frame) => Buffer.from(frame.bytes).toString() === databaseMarker,
        )
        .map((frame) => frame.componentName);
      const statePaths = frames
        .filter((frame) => frame.componentName === "state-files")
        .map((frame) => frame.entryPath);

      expect(markerComponents).toEqual(["database"]);
      expect(statePaths).toContain("custom/keep.json");
      expect(
        statePaths.some(
          (entryPath) =>
            entryPath === "custom/database" ||
            entryPath?.startsWith("custom/database/"),
        ),
      ).toBe(false);
    } finally {
      restoreEnvironmentValue("ELIZA_STATE_DIR", previousStateDir);
      restoreEnvironmentValue("PGLITE_DATA_DIR", previousPgliteDir);
      restoreEnvironmentValue("POSTGRES_URL", previousPostgresUrl);
      restoreEnvironmentValue("DATABASE_URL", previousDatabaseUrl);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "uses physical directory identity when PGLITE_DATA_DIR is a symlink alias",
    async () => {
      mockCaptureAvailableMemory();
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "eliza-backup-symlink-pgdata-"),
      );
      const stateDir = path.join(root, "state");
      const physicalPgliteDir = path.join(stateDir, ".pgdata-physical");
      const pgliteAlias = path.join(root, "pglite-alias");
      const databaseMarker = "database-only-symlink-target";
      const previousStateDir = process.env.ELIZA_STATE_DIR;
      const previousPgliteDir = process.env.PGLITE_DATA_DIR;
      const previousPostgresUrl = process.env.POSTGRES_URL;
      const previousDatabaseUrl = process.env.DATABASE_URL;
      try {
        await fs.promises.mkdir(physicalPgliteDir, { recursive: true });
        await fs.promises.writeFile(
          path.join(physicalPgliteDir, "PG_VERSION"),
          databaseMarker,
        );
        await fs.promises.symlink(physicalPgliteDir, pgliteAlias, "dir");
        process.env.ELIZA_STATE_DIR = stateDir;
        process.env.PGLITE_DATA_DIR = pgliteAlias;
        delete process.env.POSTGRES_URL;
        delete process.env.DATABASE_URL;

        const frames = await captureDefaultDataFrames(databaseMarker);
        const markerComponents = frames
          .filter(
            (frame) => Buffer.from(frame.bytes).toString() === databaseMarker,
          )
          .map((frame) => frame.componentName);
        const statePaths = frames
          .filter((frame) => frame.componentName === "state-files")
          .map((frame) => frame.entryPath);

        expect(markerComponents).toEqual(["database"]);
        expect(statePaths).not.toContain(".pgdata-physical/PG_VERSION");
      } finally {
        restoreEnvironmentValue("ELIZA_STATE_DIR", previousStateDir);
        restoreEnvironmentValue("PGLITE_DATA_DIR", previousPgliteDir);
        restoreEnvironmentValue("POSTGRES_URL", previousPostgresUrl);
        restoreEnvironmentValue("DATABASE_URL", previousDatabaseUrl);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("fails closed when PGlite contains the state directory", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-backup-overlap-pgdata-"),
    );
    const pgliteDir = path.join(root, "database");
    const stateDir = path.join(pgliteDir, "state");
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousPgliteDir = process.env.PGLITE_DATA_DIR;
    const previousPostgresUrl = process.env.POSTGRES_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    try {
      await fs.promises.mkdir(stateDir, { recursive: true });
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.PGLITE_DATA_DIR = pgliteDir;
      delete process.env.POSTGRES_URL;
      delete process.env.DATABASE_URL;

      expect(() =>
        createDefaultAgentBackupV2CaptureSources(
          { agentId: ids.agent, getSetting: () => undefined },
          {},
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "AGENT_BACKUP_V2_PGLITE_STATE_OVERLAP",
        }),
      );

      process.env.PGLITE_DATA_DIR = stateDir;
      expect(() =>
        createDefaultAgentBackupV2CaptureSources(
          { agentId: ids.agent, getSetting: () => undefined },
          {},
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "AGENT_BACKUP_V2_PGLITE_STATE_OVERLAP",
        }),
      );
    } finally {
      restoreEnvironmentValue("ELIZA_STATE_DIR", previousStateDir);
      restoreEnvironmentValue("PGLITE_DATA_DIR", previousPgliteDir);
      restoreEnvironmentValue("POSTGRES_URL", previousPostgresUrl);
      restoreEnvironmentValue("DATABASE_URL", previousDatabaseUrl);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "fails closed when a dangling PGlite alias has no physical identity",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "eliza-backup-dangling-pgdata-"),
      );
      const stateDir = path.join(root, "state");
      const pgliteAlias = path.join(root, "pglite-alias");
      const previousStateDir = process.env.ELIZA_STATE_DIR;
      const previousPgliteDir = process.env.PGLITE_DATA_DIR;
      const previousPostgresUrl = process.env.POSTGRES_URL;
      const previousDatabaseUrl = process.env.DATABASE_URL;
      try {
        await fs.promises.mkdir(stateDir, { recursive: true });
        await fs.promises.symlink(
          path.join(root, "missing-database"),
          pgliteAlias,
          "dir",
        );
        process.env.ELIZA_STATE_DIR = stateDir;
        process.env.PGLITE_DATA_DIR = pgliteAlias;
        delete process.env.POSTGRES_URL;
        delete process.env.DATABASE_URL;

        expect(() =>
          createDefaultAgentBackupV2CaptureSources(
            { agentId: ids.agent, getSetting: () => undefined },
            {},
          ),
        ).toThrowError(
          expect.objectContaining({
            code: "AGENT_BACKUP_V2_DIRECTORY_IDENTITY_UNRESOLVED",
          }),
        );
      } finally {
        restoreEnvironmentValue("ELIZA_STATE_DIR", previousStateDir);
        restoreEnvironmentValue("PGLITE_DATA_DIR", previousPgliteDir);
        restoreEnvironmentValue("POSTGRES_URL", previousPostgresUrl);
        restoreEnvironmentValue("DATABASE_URL", previousDatabaseUrl);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("fails closed when a component crashes and emits no terminal success", async () => {
    const source: AgentBackupV2CaptureComponentSource = {
      descriptor: {
        name: "database",
        format: "synthetic-v1",
        compression: "none",
        contentKind: "opaque",
        consistency: "transactional",
      },
      async *open() {
        yield { bytes: Uint8Array.of(1, 2, 3) };
        throw new Error("synthetic source crash");
      },
    };
    const capture = streamAgentBackupV2Capture({
      request: request(),
      agentId: ids.agent,
      components: [source],
    });
    let emittedFrames = 0;
    let thrown: unknown;
    try {
      for await (const _wireFrame of capture) emittedFrames += 1;
    } catch (error) {
      thrown = error;
    }

    expect(emittedFrames).toBe(3);
    expect(thrown).toMatchObject({
      code: "AGENT_BACKUP_V2_SOURCE_FAILED",
      cause: expect.objectContaining({ message: "synthetic source crash" }),
    });
  });

  it("propagates abort while a capture is in flight", async () => {
    const controller = new AbortController();
    const iterator = streamAgentBackupV2Capture({
      request: request(),
      agentId: ids.agent,
      components: [syntheticSource(2 * MIB)],
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await iterator.next();
    controller.abort(new Error("client disconnected"));

    await expect(iterator.next()).rejects.toMatchObject({
      code: "AGENT_BACKUP_V2_CAPTURE_ABORTED",
    });
  });

  it("interrupts a stuck source at the absolute deadline", async () => {
    let sourceSignal: AbortSignal | undefined;
    const never = new Promise<IteratorResult<AgentBackupV2CaptureSourceChunk>>(
      () => undefined,
    );
    const source: AgentBackupV2CaptureComponentSource = {
      descriptor: {
        name: "database",
        format: "synthetic-v1",
        compression: "none",
        contentKind: "opaque",
        consistency: "transactional",
      },
      open(signal) {
        sourceSignal = signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => never,
              return: () => never,
            };
          },
        };
      },
    };
    const iterator = streamAgentBackupV2Capture({
      request: request(30),
      agentId: ids.agent,
      components: [source],
    })[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED",
    });
    expect(sourceSignal?.aborted).toBe(true);
  });

  it("rejects a source that yields zero progress", async () => {
    const source: AgentBackupV2CaptureComponentSource = {
      descriptor: {
        name: "database",
        format: "synthetic-v1",
        compression: "none",
        contentKind: "opaque",
        consistency: "transactional",
      },
      async *open() {
        yield { bytes: new Uint8Array(0) };
      },
    };
    const consume = async (): Promise<void> => {
      for await (const _wireFrame of streamAgentBackupV2Capture({
        request: request(),
        agentId: ids.agent,
        components: [source],
      })) {
        // Consume until the producer rejects the invalid source chunk.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: "AGENT_BACKUP_V2_ZERO_PROGRESS",
    });
  });

  it("rejects a request routed to the wrong runtime agent", async () => {
    const consume = async (): Promise<void> => {
      for await (const _wireFrame of streamAgentBackupV2Capture({
        request: request(),
        agentId: "44444444-4444-4444-8444-444444444444",
        components: [syntheticSource(1)],
      })) {
        // Capture must fail before its first frame.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: "AGENT_BACKUP_V2_AGENT_MISMATCH",
    });
  });

  it("admits a real PGlite cluster that holds no user data", async () => {
    // The ceiling used to be 40 MiB, measured against the whole data directory,
    // and a cluster with zero user data measures 38.0 MiB — 2 MiB of headroom,
    // gone as soon as pgvector and fuzzystrmatch load. Being `fatal`, that made
    // agents undeletable (#23116). The existing over-limit test could not catch
    // it: a synthetic sparse file proves the comparison fires without ever
    // saying where the threshold sits. This one measures a real cluster, which
    // is the only shape that surfaces the inversion.
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-backup-empty-pglite-"),
    );
    const dataDir = path.join(root, ".pgdata");
    let db: PGlite | undefined;
    try {
      db = new PGlite({ dataDir });
      await db.waitReady;
      await db.close();
      db = undefined;

      let physicalBytes = 0;
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.promises.readdir(dir, {
          withFileTypes: true,
        })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile())
            physicalBytes += (await fs.promises.stat(full)).size;
        }
      };
      await walk(dataDir);

      // Fitting is not the bar — the old 40 MiB ceiling technically "fit" a
      // 38.0 MiB empty cluster, with 2 MiB left for everything the agent ever
      // writes, and tipped over as soon as pgvector and fuzzystrmatch loaded.
      // A ceiling meant to bound USER data must leave at least as much room as
      // the catalogs already occupy; otherwise it is a gate on initdb.
      expect(physicalBytes).toBeGreaterThan(0);
      expect(AGENT_BACKUP_V2_PGLITE_CAPTURE_LIMITS.maxPhysicalBytes).toBeGreaterThan(
        physicalBytes * 2,
      );
    } finally {
      await db?.close();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
