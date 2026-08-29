import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  type AgentBackupManifestV3,
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
});
