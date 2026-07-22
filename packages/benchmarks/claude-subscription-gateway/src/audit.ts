/**
 * Redacted audit projections for provenance and fairness review. Production
 * writes append-only hash-linked JSONL while tests retain a bounded memory view.
 */

import {
  type HashChainedJsonlCursor,
  HashChainedJsonl,
} from "./hash-chained-jsonl.js";
import type { GatewayAuditRecord } from "./types.js";
import type { JsonObject } from "./types.js";

export interface AuditSink {
  append(record: GatewayAuditRecord): void | Promise<void>;
  hasLogicalCompletion?(
    harness: string,
    logicalOrdinal: number,
    logicalKeySha256: string,
  ): boolean | Promise<boolean>;
  stats?(): { retained?: number; total: number; capacity?: number };
  close?(): Promise<void>;
}

export class InMemoryAuditStore implements AuditSink {
  private readonly capacity: number;
  private readonly records: GatewayAuditRecord[] = [];
  private totalRecords = 0;

  constructor(capacity = 1_000) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error(
        "[ClaudeSubscriptionGateway] audit capacity must be a positive integer",
      );
    }
    this.capacity = capacity;
  }

  append(record: GatewayAuditRecord): void {
    this.totalRecords += 1;
    this.records.push(structuredClone(record));
    if (this.records.length > this.capacity) this.records.shift();
  }

  hasLogicalCompletion(
    harness: string,
    logicalOrdinal: number,
    logicalKeySha256: string,
  ): boolean {
    return this.records.some(
      (record) =>
        record.harness === harness &&
        record.logicalOrdinal === logicalOrdinal &&
        record.logicalKeySha256 === logicalKeySha256 &&
        (record.auditEvent ??
          (record.status === "succeeded" ? "logical_completion" : null)) ===
          "logical_completion",
    );
  }

  snapshot(): GatewayAuditRecord[] {
    return structuredClone(this.records);
  }

  stats(): { capacity: number; retained: number; total: number } {
    return {
      capacity: this.capacity,
      retained: this.records.length,
      total: this.totalRecords,
    };
  }
}

export class DurableAuditStore implements AuditSink {
  private readonly cursors = new Map<
    string,
    {
      stream: HashChainedJsonlCursor;
      lastOrdinal: number;
      lastKey: string | null;
      lastResult: boolean | null;
      pending: JsonObject | null;
    }
  >();

  private constructor(private readonly log: HashChainedJsonl) {}

  static async open(target: string): Promise<DurableAuditStore> {
    const log = await HashChainedJsonl.open(target, {
      sequenceField: "audit_sequence",
    });
    return new DurableAuditStore(log);
  }

  async append(record: GatewayAuditRecord): Promise<void> {
    await this.log.append(toAuditArtifact(record));
    if (
      record.auditEvent === "logical_completion" &&
      record.logicalKeySha256 !== undefined &&
      record.logicalOrdinal !== undefined
    ) {
      const cursor = this.cursors.get(record.harness);
      if (
        cursor &&
        cursor.lastOrdinal === record.logicalOrdinal &&
        cursor.lastKey === record.logicalKeySha256
      ) {
        cursor.lastResult = true;
      }
    }
  }

  async hasLogicalCompletion(
    harness: string,
    logicalOrdinal: number,
    logicalKeySha256: string,
  ): Promise<boolean> {
    const cursor = this.cursors.get(harness) ?? {
      stream: this.log.createCursor(),
      lastOrdinal: -1,
      lastKey: null,
      lastResult: null,
      pending: null,
    };
    if (logicalOrdinal < cursor.lastOrdinal) {
      throw new Error("Audit logical ordinals must be queried in lane order.");
    }
    if (logicalOrdinal === cursor.lastOrdinal) {
      if (cursor.lastKey !== logicalKeySha256 || cursor.lastResult === null) {
        throw new Error("Audit logical ordinal was reused with a different key.");
      }
      return cursor.lastResult;
    }
    cursor.lastOrdinal = logicalOrdinal;
    cursor.lastKey = logicalKeySha256;
    while (true) {
      const candidate = cursor.pending;
      if (candidate !== null) cursor.pending = null;
      const next = candidate === null ? await this.log.readNext(cursor.stream) : null;
      if (candidate === null) {
        if (next === null) {
          cursor.lastResult = false;
          this.cursors.set(harness, cursor);
          return false;
        }
      }
      const record = candidate ?? next;
      if (!record) return false;
      if (
        record.harness !== harness ||
        (record.audit_event ??
          (record.status === "succeeded" ? "logical_completion" : null)) !==
          "logical_completion"
      ) {
        continue;
      }
      const ordinal = record.logical_ordinal;
      if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal)) {
        throw new Error("Audit logical completion has an invalid ordinal.");
      }
      if (ordinal < logicalOrdinal) continue;
      if (ordinal > logicalOrdinal) {
        cursor.pending = record;
        cursor.lastResult = false;
        this.cursors.set(harness, cursor);
        return false;
      }
      this.cursors.set(harness, cursor);
      if (record.logical_key_sha256 !== logicalKeySha256) {
        throw new Error("Audit logical identity conflicts with its request hash.");
      }
      cursor.lastResult = true;
      return true;
    }
  }

  stats(): { total: number } {
    return this.log.stats();
  }

  close(): Promise<void> {
    return this.log.close();
  }

}

export function toAuditArtifact(record: GatewayAuditRecord): JsonObject {
  return {
    schema_version: 2,
    request_id: record.requestId,
    recorded_at: record.recordedAt,
    harness: record.harness,
    transport: record.transport,
    credential_source: record.credentialSource,
    credential_epoch_hmac_sha256:
      record.credentialEpochHmacSha256 ?? null,
    credential_tier_hmac_sha256: record.credentialTierHmacSha256 ?? null,
    credential_capability_hmac_sha256:
      record.credentialCapabilityHmacSha256 ?? null,
    sdk_version: record.sdkVersion,
    sdk_api_key_source: record.sdkApiKeySource,
    claude_code_version: record.claudeCodeVersion,
    fresh_session: record.freshSession,
    tool_execution: record.toolExecution,
    serializer: record.serializer,
    response_mode: record.responseMode,
    model_requested: record.modelRequested,
    model_effective: record.modelEffective,
    reasoning_effort: record.reasoningEffort,
    message_count: record.messageCount,
    message_roles: record.messageRoles,
    tool_names: record.toolNames,
    tool_choice: record.toolChoice,
    parallel_tool_calls: record.parallelToolCalls,
    tool_call_names: record.toolCallNames,
    prompt_sha256: record.promptSha256,
    system_prompt_sha256: record.systemPromptSha256,
    tool_schema_sha256: record.toolSchemaSha256,
    tool_schema_sha256_by_name: record.toolSchemaSha256ByName,
    request_sha256: record.requestSha256,
    logical_namespace_sha256: record.logicalNamespaceSha256 ?? null,
    logical_ordinal: record.logicalOrdinal ?? null,
    logical_key_sha256: record.logicalKeySha256 ?? null,
    delivery_attempt: record.deliveryAttempt ?? null,
    execution_origin: record.executionOrigin ?? "original",
    audit_event:
      record.auditEvent ??
      (record.status === "succeeded" ? "logical_completion" : "failure"),
    content_attestation:
      record.contentAttestation === null
        ? null
        : {
            schema_version: record.contentAttestation.schemaVersion,
            contract_id: record.contentAttestation.contractId,
            contract_sha256: record.contentAttestation.contractSha256,
            system_hint_sha256: record.contentAttestation.systemHintSha256,
            system_hint_instruction_occurrences:
              record.contentAttestation.systemHintInstructionOccurrences,
            system_hint_user_occurrences:
              record.contentAttestation.systemHintUserOccurrences,
            system_hint_generated_occurrences:
              record.contentAttestation.systemHintGeneratedOccurrences,
            public_user_matches: record.contentAttestation.publicUserMatches,
            public_user_instruction_matches:
              record.contentAttestation.publicUserInstructionMatches,
            public_user_generated_matches:
              record.contentAttestation.publicUserGeneratedMatches,
            forbidden_ingress_match_counts:
              record.contentAttestation.forbiddenIngressMatchCounts,
            forbidden_ingress_match_total:
              record.contentAttestation.forbiddenIngressMatchTotal,
            forbidden_generated_match_counts:
              record.contentAttestation.forbiddenGeneratedMatchCounts,
            forbidden_generated_match_total:
              record.contentAttestation.forbiddenGeneratedMatchTotal,
            observed_instruction_match_counts:
              record.contentAttestation.observedInstructionMatchCounts,
            observed_user_match_counts:
              record.contentAttestation.observedUserMatchCounts,
            observed_ingress_match_counts:
              record.contentAttestation.observedIngressMatchCounts,
            observed_generated_match_counts:
              record.contentAttestation.observedGeneratedMatchCounts,
            message_content_manifest:
              record.contentAttestation.messageContentManifest,
          },
    queue_wait_ms: record.queueWaitMs,
    service_ms: record.serviceMs,
    status: record.status,
    finish_reason: record.finishReason,
    result_subtype: record.resultSubtype,
    terminal_reason: record.terminalReason,
    retry_at: record.retryAt ?? null,
    pause_reason: record.pauseReason ?? null,
    unapplied_parameters: record.unappliedParameters,
    error_code: record.errorCode,
  };
}
