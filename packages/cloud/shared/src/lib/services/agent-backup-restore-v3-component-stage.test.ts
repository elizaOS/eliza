/**
 * Exercises isolated component parsing with deterministic record streams and
 * contract-faithful staging adapters; provider and durable DB effects remain
 * outside this focused boundary.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  type AgentBackupManifestV3,
  type AgentBackupRecordStreamV1Record,
  type AgentBackupRestoreV3ComponentReceipt,
  type AgentBackupRestoreV3ExactReadReceiptProof,
  type AgentBackupRestoreV3IsolatedCandidateStaging,
  type AgentBackupRestoreV3SourceObjectReceipt,
  type AgentBackupRestoreV3StagingSession,
  serializeAgentBackupRecordStreamV1Magic,
  serializeAgentBackupRecordStreamV1Record,
} from "@elizaos/shared";
import {
  AgentBackupRestoreV3ComponentStageError,
  type AgentBackupRestoreV3ExactObjectResult,
  stageAgentBackupRestoreV3Component,
} from "./agent-backup-restore-v3-component-stage";
import { createAgentBackupRestoreV3Control } from "./agent-backup-restore-v3-control";

const CONTENT_HMAC_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SESSION = {
  restoreAttemptId: "00000000-0000-4000-8000-000000000001",
  operationId: "00000000-0000-4000-8000-000000000002",
  expectedManifestSha256: "1".repeat(64),
  stagingHandle: "staging:test",
  cleanupHandle: "cleanup:test",
  executionToken: "execution:test",
  cleanupRegistered: true,
  isolatedCandidate: true,
} as const satisfies AgentBackupRestoreV3StagingSession;

function join(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function componentWire(payload: Uint8Array): Uint8Array {
  const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[0];
  return join([
    serializeAgentBackupRecordStreamV1Magic(),
    ...serializeAgentBackupRecordStreamV1Record({
      kind: "component-start",
      descriptor,
    }),
    ...serializeAgentBackupRecordStreamV1Record({
      kind: "data",
      dataIndex: 0,
      offsetBytes: 0,
      payloadBytes: payload.byteLength,
      entry: null,
      payload,
    }),
    ...serializeAgentBackupRecordStreamV1Record({
      kind: "component-end",
      dataFrameCount: 1,
      payloadBytes: payload.byteLength,
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
    }),
  ]);
}

function manifestFor(wire: Uint8Array, objectCount: number): AgentBackupManifestV3 {
  const contentHmac = createHmac("sha256", CONTENT_HMAC_KEY).update(wire).digest("hex");
  return {
    components: [
      {
        name: "character",
        payloadContentHmacSha256: contentHmac,
        state: { kind: "full", resultContentHmacSha256: contentHmac },
        totals: { plainBytes: wire.byteLength },
        chunks: Array.from({ length: objectCount }, (_, index) => ({ index })),
      },
    ],
  } as unknown as AgentBackupManifestV3;
}

function exactResult(index: number): AgentBackupRestoreV3ExactObjectResult {
  return {
    proof: { slot: `proof-${index}` } as unknown as AgentBackupRestoreV3ExactReadReceiptProof,
    receipt: {
      slot: `receipt-${index}`,
    } as unknown as AgentBackupRestoreV3SourceObjectReceipt,
  };
}

function exactStream(
  bytes: Uint8Array,
  result: AgentBackupRestoreV3ExactObjectResult,
): () => AsyncGenerator<Uint8Array, AgentBackupRestoreV3ExactObjectResult, void> {
  return async function* stream() {
    const split = Math.max(1, Math.floor(bytes.byteLength / 2));
    yield bytes.slice(0, split);
    if (split < bytes.byteLength) yield bytes.slice(split);
    return result;
  };
}

function recordWire(records: readonly AgentBackupRecordStreamV1Record[]): Uint8Array {
  const parts: Uint8Array[] = [serializeAgentBackupRecordStreamV1Magic()];
  for (const record of records) {
    parts.push(...serializeAgentBackupRecordStreamV1Record(record));
  }
  return join(parts);
}

function stagingFixture(
  overrides: Partial<AgentBackupRestoreV3IsolatedCandidateStaging> = {},
): AgentBackupRestoreV3IsolatedCandidateStaging {
  return {
    begin: () => SESSION,
    stageRecord: (_session, record) => ({
      componentIndex: record.componentIndex,
      componentName: record.componentName,
      dataIndex: record.dataIndex,
      offsetBytes: record.offsetBytes,
      entry: record.entry,
      payloadBytes: record.payload.byteLength,
      payloadSha256: createHash("sha256").update(record.payload).digest("hex"),
    }),
    finishComponent: (_session, receipt) => receipt,
    seal: () => {
      throw new Error("not used by component staging");
    },
    abort: () => true,
    ...overrides,
  };
}

interface RejectionFixture {
  readonly wire: Uint8Array;
  readonly manifest?: AgentBackupManifestV3;
  readonly objectStreams?: readonly (() => AsyncGenerator<
    Uint8Array,
    AgentBackupRestoreV3ExactObjectResult,
    void
  >)[];
  readonly staging?: AgentBackupRestoreV3IsolatedCandidateStaging;
  readonly contentHmacKey?: Uint8Array;
}

async function expectStageRejection(
  fixture: RejectionFixture,
  code: AgentBackupRestoreV3ComponentStageError["code"],
): Promise<void> {
  const objectStreams = fixture.objectStreams ?? [exactStream(fixture.wire, exactResult(0))];
  const control = createAgentBackupRestoreV3Control({
    signal: new AbortController().signal,
    deadlineEpochMs: Date.now() + 5_000,
    reportDetachedFailure: () => undefined,
  });
  try {
    await expect(
      stageAgentBackupRestoreV3Component({
        manifest: fixture.manifest ?? manifestFor(fixture.wire, objectStreams.length),
        componentIndex: 0,
        objectStreams,
        session: SESSION,
        staging: fixture.staging ?? stagingFixture(),
        contentHmacKey: fixture.contentHmacKey ?? CONTENT_HMAC_KEY,
        observeFramedPlaintext: () => undefined,
        control,
      }),
    ).rejects.toMatchObject<Partial<AgentBackupRestoreV3ComponentStageError>>({ code });
  } finally {
    control.close();
  }
}

function mutableManifestComponent(manifest: AgentBackupManifestV3): {
  payloadContentHmacSha256: string;
  state: { kind: string; resultContentHmacSha256: string };
  totals: { plainBytes: number };
} {
  const component = manifest.components[0];
  if (!component) throw new Error("Fixture manifest component is absent");
  return component as unknown as {
    payloadContentHmacSha256: string;
    state: { kind: string; resultContentHmacSha256: string };
    totals: { plainBytes: number };
  };
}

describe("stageAgentBackupRestoreV3Component", () => {
  test("parses one authenticated record stream across exact-object boundaries", async () => {
    const payload = new TextEncoder().encode("isolated character state");
    const wire = componentWire(payload);
    const boundary = 13;
    const observed: Uint8Array[] = [];
    const stagedCopies: Uint8Array[] = [];
    let ephemeralPayload: Uint8Array | undefined;
    let finishedReceipt: AgentBackupRestoreV3ComponentReceipt | undefined;
    const staging: AgentBackupRestoreV3IsolatedCandidateStaging = {
      begin: () => SESSION,
      stageRecord: (_session, record) => {
        ephemeralPayload = record.payload;
        stagedCopies.push(Uint8Array.from(record.payload));
        return {
          componentIndex: record.componentIndex,
          componentName: record.componentName,
          dataIndex: record.dataIndex,
          offsetBytes: record.offsetBytes,
          entry: record.entry,
          payloadBytes: record.payload.byteLength,
          payloadSha256: createHash("sha256").update(record.payload).digest("hex"),
        };
      },
      finishComponent: (_session, receipt) => {
        finishedReceipt = receipt;
        return receipt;
      },
      seal: () => {
        throw new Error("not used by component staging");
      },
      abort: () => true,
    };
    const caller = new AbortController();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 5_000,
      reportDetachedFailure: () => undefined,
    });

    try {
      const result = await stageAgentBackupRestoreV3Component({
        manifest: manifestFor(wire, 2),
        componentIndex: 0,
        objectStreams: [
          exactStream(wire.slice(0, boundary), exactResult(0)),
          exactStream(wire.slice(boundary), exactResult(1)),
        ],
        session: SESSION,
        staging,
        contentHmacKey: CONTENT_HMAC_KEY,
        observeFramedPlaintext: (bytes) => observed.push(Uint8Array.from(bytes)),
        control,
      });

      expect(join(observed)).toEqual(wire);
      expect(stagedCopies).toEqual([payload]);
      expect(ephemeralPayload).toEqual(new Uint8Array(payload.byteLength));
      expect(result.component).toEqual(finishedReceipt);
      expect(result.component).toMatchObject({
        componentIndex: 0,
        componentName: "character",
        dataFrameCount: 1,
        payloadBytes: payload.byteLength,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
      });
      expect(result.exactReadProofs).toEqual([exactResult(0).proof, exactResult(1).proof]);
      expect(result.sourceObjects).toEqual([exactResult(0).receipt, exactResult(1).receipt]);
    } finally {
      control.close();
    }
  });

  test("does not advance component finalization while an isolated record write is pending", async () => {
    const payload = new TextEncoder().encode("backpressured isolated state");
    const wire = componentWire(payload);
    const stageStarted = deferred<void>();
    const releaseStage = deferred<void>();
    let finishCount = 0;
    const staging: AgentBackupRestoreV3IsolatedCandidateStaging = {
      begin: () => SESSION,
      async stageRecord(_session, record) {
        stageStarted.resolve(undefined);
        await releaseStage.promise;
        return {
          componentIndex: record.componentIndex,
          componentName: record.componentName,
          dataIndex: record.dataIndex,
          offsetBytes: record.offsetBytes,
          entry: record.entry,
          payloadBytes: record.payload.byteLength,
          payloadSha256: createHash("sha256").update(record.payload).digest("hex"),
        };
      },
      finishComponent: (_session, receipt) => {
        finishCount += 1;
        return receipt;
      },
      seal: () => {
        throw new Error("not used by component staging");
      },
      abort: () => true,
    };
    const control = createAgentBackupRestoreV3Control({
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + 5_000,
      reportDetachedFailure: () => undefined,
    });

    try {
      const operation = stageAgentBackupRestoreV3Component({
        manifest: manifestFor(wire, 1),
        componentIndex: 0,
        objectStreams: [exactStream(wire, exactResult(0))],
        session: SESSION,
        staging,
        contentHmacKey: CONTENT_HMAC_KEY,
        observeFramedPlaintext: () => undefined,
        control,
      });

      await stageStarted.promise;
      expect(finishCount).toBe(0);
      releaseStage.resolve(undefined);
      await operation;
      expect(finishCount).toBe(1);
    } finally {
      control.close();
    }
  });

  test("closes an unfinished exact-object iterator without inventing its receipt", async () => {
    const payload = Uint8Array.of(1, 2, 3, 4);
    const wire = componentWire(payload);
    let iteratorClosed = false;
    const unfinished = async function* (): AsyncGenerator<
      Uint8Array,
      AgentBackupRestoreV3ExactObjectResult,
      void
    > {
      try {
        yield wire;
        return exactResult(0);
      } finally {
        iteratorClosed = true;
      }
    };
    const staging: AgentBackupRestoreV3IsolatedCandidateStaging = {
      begin: () => SESSION,
      stageRecord: (_session, record) => ({
        componentIndex: record.componentIndex,
        componentName: record.componentName,
        dataIndex: record.dataIndex,
        offsetBytes: record.offsetBytes,
        entry: record.entry,
        payloadBytes: record.payload.byteLength,
        payloadSha256: "f".repeat(64),
      }),
      finishComponent: (_session, receipt) => receipt,
      seal: () => {
        throw new Error("not used by component staging");
      },
      abort: () => true,
    };
    const control = createAgentBackupRestoreV3Control({
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + 5_000,
      reportDetachedFailure: () => undefined,
    });

    try {
      await expect(
        stageAgentBackupRestoreV3Component({
          manifest: manifestFor(wire, 1),
          componentIndex: 0,
          objectStreams: [unfinished],
          session: SESSION,
          staging,
          contentHmacKey: CONTENT_HMAC_KEY,
          observeFramedPlaintext: () => undefined,
          control,
        }),
      ).rejects.toMatchObject<Partial<AgentBackupRestoreV3ComponentStageError>>({
        code: "AGENT_BACKUP_RESTORE_V3_STAGE_RECEIPT_CONFLICT",
      });
      expect(iteratorClosed).toBe(true);
    } finally {
      control.close();
    }
  });

  test("rejects a record stream whose HMAC differs from the manifest payload authority", async () => {
    const wire = componentWire(new TextEncoder().encode("manifest HMAC mismatch"));
    const manifest = manifestFor(wire, 1);
    mutableManifestComponent(manifest).payloadContentHmacSha256 = "f".repeat(64);

    await expectStageRejection(
      { wire, manifest },
      "AGENT_BACKUP_RESTORE_V3_COMPONENT_HMAC_MISMATCH",
    );
  });

  test("rejects a record stream whose HMAC differs from the manifest result authority", async () => {
    const wire = componentWire(new TextEncoder().encode("result HMAC mismatch"));
    const manifest = manifestFor(wire, 1);
    mutableManifestComponent(manifest).state.resultContentHmacSha256 = "f".repeat(64);

    await expectStageRejection(
      { wire, manifest },
      "AGENT_BACKUP_RESTORE_V3_COMPONENT_HMAC_MISMATCH",
    );
  });

  test("rejects a manifest component whose result state is not full", async () => {
    const wire = componentWire(new TextEncoder().encode("non-full result state"));
    const manifest = manifestFor(wire, 1);
    mutableManifestComponent(manifest).state.kind = "delta";

    await expectStageRejection(
      { wire, manifest },
      "AGENT_BACKUP_RESTORE_V3_COMPONENT_HMAC_MISMATCH",
    );
  });

  test("rejects manifest plaintext accounting that differs from the exact record stream", async () => {
    const wire = componentWire(new TextEncoder().encode("plain byte mismatch"));
    const manifest = manifestFor(wire, 1);
    mutableManifestComponent(manifest).totals.plainBytes = wire.byteLength + 1;

    await expectStageRejection(
      { wire, manifest },
      "AGENT_BACKUP_RESTORE_V3_RECORD_STREAM_TRUNCATED",
    );
  });

  test("rejects a conflicting isolated-component finalization receipt", async () => {
    const wire = componentWire(new TextEncoder().encode("conflicting final receipt"));
    const staging = stagingFixture({
      finishComponent: (_session, receipt) => ({
        ...receipt,
        payloadBytes: receipt.payloadBytes + 1,
      }),
    });

    await expectStageRejection(
      { wire, staging },
      "AGENT_BACKUP_RESTORE_V3_COMPONENT_RECEIPT_CONFLICT",
    );
  });

  test("rejects a record-stream descriptor for a different component", async () => {
    const payload = new TextEncoder().encode("wrong descriptor");
    const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[1];
    if (!descriptor) throw new Error("Fixture mismatch descriptor is absent");
    const wire = recordWire([
      { kind: "component-start", descriptor },
      {
        kind: "data",
        dataIndex: 0,
        offsetBytes: 0,
        payloadBytes: payload.byteLength,
        entry: null,
        payload,
      },
      {
        kind: "component-end",
        dataFrameCount: 1,
        payloadBytes: payload.byteLength,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
      },
    ]);

    await expectStageRejection({ wire }, "AGENT_BACKUP_RESTORE_V3_DESCRIPTOR_MISMATCH");
  });

  test("rejects an exact-object cardinality that differs from manifest chunks before reading", async () => {
    const wire = componentWire(new TextEncoder().encode("object cardinality mismatch"));
    let factoryCalled = false;
    const stream = async function* (): AsyncGenerator<
      Uint8Array,
      AgentBackupRestoreV3ExactObjectResult,
      void
    > {
      factoryCalled = true;
      yield wire;
      return exactResult(0);
    };

    await expectStageRejection(
      {
        wire,
        manifest: manifestFor(wire, 2),
        objectStreams: [stream],
      },
      "AGENT_BACKUP_RESTORE_V3_COMPONENT_INPUT_INVALID",
    );
    expect(factoryCalled).toBe(false);
  });

  test("rejects an empty plaintext fragment from an exact-object stream", async () => {
    const wire = componentWire(new TextEncoder().encode("non-empty exact bytes"));
    const stream = async function* (): AsyncGenerator<
      Uint8Array,
      AgentBackupRestoreV3ExactObjectResult,
      void
    > {
      yield new Uint8Array(0);
      yield wire;
      return exactResult(0);
    };

    await expectStageRejection(
      { wire, objectStreams: [stream] },
      "AGENT_BACKUP_RESTORE_V3_PLAINTEXT_FRAGMENT_INVALID",
    );
  });

  test("requires both completion proof and source-object receipt from every exact stream", async () => {
    const wire = componentWire(new TextEncoder().encode("missing exact result authority"));
    const results = [
      {
        proof: exactResult(0).proof,
        receipt: undefined,
      },
      {
        proof: undefined,
        receipt: exactResult(0).receipt,
      },
    ] as const;

    for (const result of results) {
      const stream = async function* (): AsyncGenerator<
        Uint8Array,
        AgentBackupRestoreV3ExactObjectResult,
        void
      > {
        yield wire;
        return result as unknown as AgentBackupRestoreV3ExactObjectResult;
      };
      await expectStageRejection(
        { wire, objectStreams: [stream] },
        "AGENT_BACKUP_RESTORE_V3_OBJECT_RECEIPT_MISSING",
      );
    }
  });

  test("requires an exact 32-byte component HMAC key", async () => {
    const wire = componentWire(new TextEncoder().encode("exact key length"));

    for (const byteLength of [31, 33]) {
      await expectStageRejection(
        { wire, contentHmacKey: new Uint8Array(byteLength) },
        "AGENT_BACKUP_RESTORE_V3_COMPONENT_INPUT_INVALID",
      );
    }
  });

  test("rejects terminal counter mismatches at the strict parser boundary", async () => {
    const payload = new TextEncoder().encode("terminal counter mismatch");
    const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[0];
    if (!descriptor) throw new Error("Fixture component descriptor is absent");
    const terminals = [
      { dataFrameCount: 0, payloadBytes: payload.byteLength },
      { dataFrameCount: 1, payloadBytes: payload.byteLength + 1 },
    ] as const;

    for (const terminal of terminals) {
      const wire = recordWire([
        { kind: "component-start", descriptor },
        {
          kind: "data",
          dataIndex: 0,
          offsetBytes: 0,
          payloadBytes: payload.byteLength,
          entry: null,
          payload,
        },
        {
          kind: "component-end",
          ...terminal,
          payloadSha256: createHash("sha256").update(payload).digest("hex"),
        },
      ]);
      await expectStageRejection({ wire }, "AGENT_BACKUP_RESTORE_V3_RECORD_STREAM_INVALID");
    }
  });

  test("rejects data outside the component interval at the strict parser boundary", async () => {
    const payload = Uint8Array.of(4, 5, 6);
    const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[0];
    if (!descriptor) throw new Error("Fixture component descriptor is absent");
    const data = {
      kind: "data" as const,
      dataIndex: 0,
      offsetBytes: 0,
      payloadBytes: payload.byteLength,
      entry: null,
      payload,
    };
    const emptyTerminal = {
      kind: "component-end" as const,
      dataFrameCount: 0,
      payloadBytes: 0,
      payloadSha256: createHash("sha256").update(new Uint8Array(0)).digest("hex"),
    };
    const invalidRecordOrders: readonly (readonly AgentBackupRecordStreamV1Record[])[] = [
      [data, { kind: "component-start", descriptor }, emptyTerminal],
      [{ kind: "component-start", descriptor }, emptyTerminal, data],
    ];

    for (const records of invalidRecordOrders) {
      const wire = recordWire(records);
      await expectStageRejection({ wire }, "AGENT_BACKUP_RESTORE_V3_RECORD_STREAM_INVALID");
    }
  });

  test("rejects a record stream truncated inside its terminal frame", async () => {
    const completeWire = componentWire(new TextEncoder().encode("truncated terminal frame"));
    const wire = completeWire.slice(0, -1);

    await expectStageRejection({ wire }, "AGENT_BACKUP_RESTORE_V3_RECORD_STREAM_INVALID");
  });

  test("destroys component HMAC state when staging rejects", async () => {
    const wire = componentWire(new TextEncoder().encode("destroy rejected HMAC"));
    const manifest = manifestFor(wire, 1);
    mutableManifestComponent(manifest).totals.plainBytes = wire.byteLength + 1;
    const probe = createHmac("sha256", CONTENT_HMAC_KEY);
    const hmacPrototype = Object.getPrototypeOf(probe) as Pick<typeof probe, "destroy">;
    probe.destroy();
    const destroySpy = spyOn(hmacPrototype, "destroy");

    try {
      await expectStageRejection(
        { wire, manifest },
        "AGENT_BACKUP_RESTORE_V3_RECORD_STREAM_TRUNCATED",
      );
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      destroySpy.mockRestore();
    }
  });
});
