/**
 * Parses one multi-object component stream into rollbackable isolated staging.
 * Plaintext records remain unauthenticated until every exact-object generator
 * returns its proof and the component HMAC and terminal receipt agree. Staging
 * must never expose them to boot, live state, or another consumer before the
 * enclosing candidate is authorized and sealed.
 *
 * This boundary owns no source selection, KMS lifetime, database, Agent, or
 * live state.
 */

import { createHash, createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ElizaError } from "@elizaos/core";
import {
  AGENT_BACKUP_RECORD_STREAM_V1_LIMITS,
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
  type AgentBackupManifestV3,
  AgentBackupRestoreV3ComponentReceiptSchema,
  type AgentBackupRestoreV3ExactReadReceiptProof,
  type AgentBackupRestoreV3IsolatedCandidateStaging,
  type AgentBackupRestoreV3SourceObjectReceipt,
  AgentBackupRestoreV3StageRecordReceiptSchema,
  type AgentBackupRestoreV3StagingSession,
  parseAgentBackupRecordStreamV1,
} from "@elizaos/shared";
import { logger } from "../utils/logger";
import type { AgentBackupRestoreV3Control } from "./agent-backup-restore-v3-control";

export interface AgentBackupRestoreV3ExactObjectResult {
  readonly proof: AgentBackupRestoreV3ExactReadReceiptProof;
  readonly receipt: AgentBackupRestoreV3SourceObjectReceipt;
}

export type AgentBackupRestoreV3ExactObjectStreamFactory = () => AsyncGenerator<
  Uint8Array,
  AgentBackupRestoreV3ExactObjectResult,
  void
>;

export interface StageAgentBackupRestoreV3ComponentInput {
  readonly manifest: AgentBackupManifestV3;
  readonly componentIndex: number;
  readonly objectStreams: readonly AgentBackupRestoreV3ExactObjectStreamFactory[];
  readonly session: AgentBackupRestoreV3StagingSession;
  readonly staging: AgentBackupRestoreV3IsolatedCandidateStaging;
  readonly contentHmacKey: Uint8Array;
  /** Called synchronously once for every plaintext fragment in exact order. */
  readonly observeFramedPlaintext: (bytes: Uint8Array) => void;
  readonly control: AgentBackupRestoreV3Control;
  readonly now?: () => number;
}

export interface StageAgentBackupRestoreV3ComponentResult {
  readonly component: ReturnType<typeof AgentBackupRestoreV3ComponentReceiptSchema.parse>;
  readonly exactReadProofs: readonly AgentBackupRestoreV3ExactReadReceiptProof[];
  readonly sourceObjects: readonly AgentBackupRestoreV3SourceObjectReceipt[];
}

export type AgentBackupRestoreV3ComponentStageErrorCode =
  | "AGENT_BACKUP_RESTORE_V3_COMPONENT_HMAC_MISMATCH"
  | "AGENT_BACKUP_RESTORE_V3_COMPONENT_INPUT_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_COMPONENT_RECEIPT_CONFLICT"
  | "AGENT_BACKUP_RESTORE_V3_DESCRIPTOR_MISMATCH"
  | "AGENT_BACKUP_RESTORE_V3_OBJECT_RECEIPT_MISSING"
  | "AGENT_BACKUP_RESTORE_V3_PLAINTEXT_FRAGMENT_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_RECORD_STATE_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_RECORD_STREAM_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_RECORD_STREAM_TRUNCATED"
  | "AGENT_BACKUP_RESTORE_V3_RECORD_TERMINAL_MISMATCH"
  | "AGENT_BACKUP_RESTORE_V3_SHA_STATE_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_STAGE_RECEIPT_CONFLICT";

export class AgentBackupRestoreV3ComponentStageError extends ElizaError {
  override readonly name = "AgentBackupRestoreV3ComponentStageError";

  constructor(
    code: AgentBackupRestoreV3ComponentStageErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, {
      code,
      cause: options?.cause,
      context: { subsystem: "agent-backup-restore-v3-component-stage" },
      severity: "fatal",
    });
  }
}

function stageError(
  code: AgentBackupRestoreV3ComponentStageErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new AgentBackupRestoreV3ComponentStageError(code, message, { cause });
}

function teardownErrorShape(cause: unknown): Readonly<{ name: string; code?: string }> {
  if (!cause || typeof cause !== "object") {
    return Object.freeze({ name: "UnknownError" });
  }
  const value = cause as { name?: unknown; code?: unknown };
  return Object.freeze({
    name: typeof value.name === "string" ? value.name : "UnknownError",
    ...(typeof value.code === "string" ? { code: value.code } : {}),
  });
}

function sha256StreamFactory(): {
  update(bytes: Uint8Array): void;
  digestHex(): string;
} {
  const hash = createHash("sha256");
  let finished = false;
  return {
    update(bytes) {
      if (finished) {
        stageError(
          "AGENT_BACKUP_RESTORE_V3_SHA_STATE_INVALID",
          "Record-stream SHA-256 was updated after finalization",
        );
      }
      hash.update(bytes);
    },
    digestHex() {
      if (finished) {
        stageError(
          "AGENT_BACKUP_RESTORE_V3_SHA_STATE_INVALID",
          "Record-stream SHA-256 was finalized twice",
        );
      }
      finished = true;
      return hash.digest("hex");
    },
  };
}

/**
 * Stage one component without exposing its unauthenticated plaintext. Exact
 * object return receipts are captured, never inferred; only the enclosing
 * candidate seal may authorize later use of the staged bytes.
 */
export async function stageAgentBackupRestoreV3Component(
  input: Readonly<StageAgentBackupRestoreV3ComponentInput>,
): Promise<StageAgentBackupRestoreV3ComponentResult> {
  const componentName = AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[input.componentIndex];
  const expectedDescriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[input.componentIndex];
  const manifestComponent = input.manifest.components[input.componentIndex];
  if (
    !componentName ||
    !expectedDescriptor ||
    !manifestComponent ||
    manifestComponent.name !== componentName ||
    input.objectStreams.length !== manifestComponent.chunks.length ||
    input.objectStreams.length === 0 ||
    !(input.contentHmacKey instanceof Uint8Array) ||
    input.contentHmacKey.byteLength !== 32
  ) {
    stageError(
      "AGENT_BACKUP_RESTORE_V3_COMPONENT_INPUT_INVALID",
      "Restore component staging input differs from its exact manifest",
    );
  }

  const componentHmac = createHmac("sha256", input.contentHmacKey);
  try {
    const exactReadProofs: AgentBackupRestoreV3ExactReadReceiptProof[] = [];
    const sourceObjects: AgentBackupRestoreV3SourceObjectReceipt[] = [];
    let recordStreamBytes = 0;

    async function* plaintext(): AsyncGenerator<Uint8Array> {
      for (const [objectIndex, createStream] of input.objectStreams.entries()) {
        input.control.assertActive("Exact restore object");
        const iterator = createStream();
        let completed = false;
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              if (!next.value?.proof || !next.value.receipt) {
                stageError(
                  "AGENT_BACKUP_RESTORE_V3_OBJECT_RECEIPT_MISSING",
                  "Exact object stream ended without its completion proof",
                );
              }
              exactReadProofs.push(next.value.proof);
              sourceObjects.push(next.value.receipt);
              completed = true;
              break;
            }
            if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
              stageError(
                "AGENT_BACKUP_RESTORE_V3_PLAINTEXT_FRAGMENT_INVALID",
                "Exact object stream emitted an invalid plaintext fragment",
              );
            }
            recordStreamBytes += next.value.byteLength;
            componentHmac.update(next.value);
            input.observeFramedPlaintext(next.value);
            yield next.value;
          }
        } finally {
          if (!completed) {
            try {
              await iterator.return(undefined as never);
            } catch (closeFailure: unknown) {
              // error-policy:J6 the parser/crypto failure remains authoritative;
              // the exact-object helper independently bounds reader cancellation.
              logger.warn(
                "[AgentBackupRestoreV3ComponentStage] exact-object iterator close failed",
                {
                  componentIndex: input.componentIndex,
                  objectIndex,
                  error: teardownErrorShape(closeFailure),
                },
              );
            }
          }
        }
      }
    }

    let descriptor: (typeof AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS)[number] | undefined;
    let dataFrameCount = 0;
    let payloadBytes = 0;
    let payloadSha256: string | undefined;
    let sawEnd = false;
    try {
      for await (const record of parseAgentBackupRecordStreamV1(plaintext(), {
        sha256StreamFactory,
        maxIngressChunkBytes: AGENT_BACKUP_RECORD_STREAM_V1_LIMITS.maxIngressChunkBytes,
        signal: input.control.signal,
        deadlineEpochMs: input.control.deadlineEpochMs,
        now: input.now,
      })) {
        input.control.assertActive("Restore component record stream");
        if (record.kind === "component-start") {
          if (descriptor || !isDeepStrictEqual(record.descriptor, expectedDescriptor)) {
            stageError(
              "AGENT_BACKUP_RESTORE_V3_DESCRIPTOR_MISMATCH",
              "Record-stream descriptor differs from its exact component contract",
            );
          }
          descriptor = Object.freeze({ ...record.descriptor }) as typeof expectedDescriptor;
          continue;
        }
        if (record.kind === "data") {
          if (!descriptor || sawEnd) {
            record.payload.fill(0);
            stageError(
              "AGENT_BACKUP_RESTORE_V3_RECORD_STATE_INVALID",
              "Record-stream data appeared outside its component interval",
            );
          }
          const stagedPayload = Uint8Array.from(record.payload);
          try {
            const expected = AgentBackupRestoreV3StageRecordReceiptSchema.parse({
              componentIndex: input.componentIndex,
              componentName,
              dataIndex: record.dataIndex,
              offsetBytes: record.offsetBytes,
              entry: record.entry ? { ...record.entry } : null,
              payloadBytes: stagedPayload.byteLength,
              payloadSha256: createHash("sha256").update(stagedPayload).digest("hex"),
            });
            const acknowledged = AgentBackupRestoreV3StageRecordReceiptSchema.parse(
              await input.control.wait("Isolated plaintext record stage", () =>
                input.staging.stageRecord(
                  input.session,
                  {
                    componentIndex: input.componentIndex,
                    componentName,
                    dataIndex: record.dataIndex,
                    offsetBytes: record.offsetBytes,
                    entry: record.entry ? { ...record.entry } : null,
                    payload: stagedPayload,
                  },
                  input.control,
                ),
              ),
            );
            if (!isDeepStrictEqual(acknowledged, expected)) {
              stageError(
                "AGENT_BACKUP_RESTORE_V3_STAGE_RECEIPT_CONFLICT",
                "Isolated staging returned a conflicting record receipt",
              );
            }
            dataFrameCount += 1;
            payloadBytes += record.payload.byteLength;
          } finally {
            stagedPayload.fill(0);
            record.payload.fill(0);
          }
          continue;
        }
        if (!descriptor || sawEnd) {
          stageError(
            "AGENT_BACKUP_RESTORE_V3_RECORD_STATE_INVALID",
            "Record-stream terminal appeared outside its component interval",
          );
        }
        if (record.dataFrameCount !== dataFrameCount || record.payloadBytes !== payloadBytes) {
          stageError(
            "AGENT_BACKUP_RESTORE_V3_RECORD_TERMINAL_MISMATCH",
            "Record-stream terminal accounting differs from staged data",
          );
        }
        payloadSha256 = record.payloadSha256;
        sawEnd = true;
      }
    } catch (cause) {
      // error-policy:J2 preserve the strict parser or exact-object failure behind
      // this component boundary while retaining already-structured stage errors.
      if (cause instanceof AgentBackupRestoreV3ComponentStageError) throw cause;
      stageError(
        "AGENT_BACKUP_RESTORE_V3_RECORD_STREAM_INVALID",
        "Component record stream failed strict validation",
        cause,
      );
    }

    if (
      !descriptor ||
      !sawEnd ||
      !payloadSha256 ||
      recordStreamBytes !== manifestComponent.totals.plainBytes ||
      exactReadProofs.length !== input.objectStreams.length ||
      sourceObjects.length !== input.objectStreams.length
    ) {
      stageError(
        "AGENT_BACKUP_RESTORE_V3_RECORD_STREAM_TRUNCATED",
        "Component stream lacks terminal state or exact object receipts",
      );
    }
    const recordStreamContentHmacSha256 = componentHmac.digest("hex");
    if (
      recordStreamContentHmacSha256 !== manifestComponent.payloadContentHmacSha256 ||
      manifestComponent.state.kind !== "full" ||
      manifestComponent.state.resultContentHmacSha256 !== recordStreamContentHmacSha256
    ) {
      stageError(
        "AGENT_BACKUP_RESTORE_V3_COMPONENT_HMAC_MISMATCH",
        "Component record-stream HMAC differs from manifest-v3",
      );
    }

    const component = AgentBackupRestoreV3ComponentReceiptSchema.parse({
      componentIndex: input.componentIndex,
      componentName,
      descriptor,
      dataFrameCount,
      payloadBytes,
      payloadSha256,
      recordStreamContentHmacSha256,
    });
    const finished = AgentBackupRestoreV3ComponentReceiptSchema.parse(
      await input.control.wait("Isolated component finalization", () =>
        input.staging.finishComponent(input.session, component, input.control),
      ),
    );
    if (!isDeepStrictEqual(finished, component)) {
      stageError(
        "AGENT_BACKUP_RESTORE_V3_COMPONENT_RECEIPT_CONFLICT",
        "Isolated component finalization returned a conflicting receipt",
      );
    }
    return Object.freeze({
      component: Object.freeze(component),
      exactReadProofs: Object.freeze(exactReadProofs),
      sourceObjects: Object.freeze(sourceObjects),
    });
  } finally {
    componentHmac.destroy();
  }
}
