/**
 * Private completion journal for exact crash replay. Raw model output stays in
 * this 0600 hash-chain and is committed before the corresponding redacted audit
 * record; three forward-only lane cursors keep restart lookup O(N) and bounded.
 */

import {
  HashChainCorruptionError,
  type HashChainedJsonlCursor,
  HashChainedJsonl,
} from "./hash-chained-jsonl.js";
import {
  computeLogicalKeySha256,
  type LogicalRequest,
} from "./logical-request.js";
import type {
  CapturedToolCall,
  ClaudeCompletionResult,
  CompletionUsage,
  JsonObject,
} from "./types.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface ReplayCompletion {
  requestId: string;
  created: number;
  queueWaitMs: number;
  result: ClaudeCompletionResult;
}

interface ReplayCursor {
  stream: HashChainedJsonlCursor;
  lastOrdinal: number;
  lastKey: string | null;
  lastResult: ReplayCompletion | null | undefined;
  pending: JsonObject | null;
}

export class ReplayMismatchError extends Error {
  readonly code = "replay_identity_mismatch";
  readonly statusCode = 409;

  constructor() {
    super("A replay ordinal was reused with different canonical request content.");
    this.name = "ReplayMismatchError";
  }
}

export class ReplayJournal {
  private readonly cursors = new Map<string, ReplayCursor>();
  private readonly lastOutcomeOrdinal = new Map<string, number>();
  private expectedTierHash: string | null = null;
  private expectedCapabilityHash: string | null = null;

  private constructor(private readonly log: HashChainedJsonl) {}

  static async open(target: string): Promise<ReplayJournal> {
    let journal: ReplayJournal | null = null;
    const lastOrdinal = new Map<string, number>();
    let expectedTierHash: string | null = null;
    let expectedCapabilityHash: string | null = null;
    const log = await HashChainedJsonl.open(
      target,
      { sequenceField: "journal_sequence" },
      (record) => {
        const parsed = parseJournalRecord(record);
        const prior = lastOrdinal.get(parsed.harness) ?? -1;
        if (parsed.logicalOrdinal !== prior + 1) {
          throw new HashChainCorruptionError(
            "Replay journal logical outcomes are not contiguous within a lane.",
          );
        }
        lastOrdinal.set(parsed.harness, parsed.logicalOrdinal);
        expectedTierHash = enforceParity(
          expectedTierHash,
          parsed.result.credentialTierHmacSha256,
          "tier",
        );
        expectedCapabilityHash = enforceParity(
          expectedCapabilityHash,
          parsed.result.credentialCapabilityHmacSha256,
          "capability",
        );
      },
    );
    journal = new ReplayJournal(log);
    for (const [harness, ordinal] of lastOrdinal) {
      journal.lastOutcomeOrdinal.set(harness, ordinal);
    }
    journal.expectedTierHash = expectedTierHash;
    journal.expectedCapabilityHash = expectedCapabilityHash;
    return journal;
  }

  async lookup(logical: LogicalRequest): Promise<ReplayCompletion | null> {
    const cursor = this.cursors.get(logical.harness) ?? {
      stream: this.log.createCursor(),
      lastOrdinal: -1,
      lastKey: null,
      lastResult: undefined,
      pending: null,
    };
    if (logical.ordinal < cursor.lastOrdinal) {
      throw new ReplayMismatchError();
    }
    if (logical.ordinal === cursor.lastOrdinal) {
      if (cursor.lastKey !== logical.logicalKeySha256) {
        throw new ReplayMismatchError();
      }
      if (cursor.lastResult !== undefined) return cursor.lastResult;
    }
    cursor.lastOrdinal = logical.ordinal;
    cursor.lastKey = logical.logicalKeySha256;
    while (true) {
      const pending = cursor.pending;
      if (pending !== null) cursor.pending = null;
      const next = pending === null ? await this.log.readNext(cursor.stream) : null;
      if (pending === null) {
        if (next === null) {
          cursor.lastResult = null;
          this.cursors.set(logical.harness, cursor);
          return null;
        }
      }
      const raw = pending ?? next;
      if (!raw) return null;
      const record = parseJournalRecord(raw);
      if (record.harness !== logical.harness) continue;
      if (record.logicalOrdinal < logical.ordinal) continue;
      if (record.logicalOrdinal > logical.ordinal) {
        cursor.pending = raw;
        cursor.lastResult = null;
        this.cursors.set(logical.harness, cursor);
        return null;
      }
      this.cursors.set(logical.harness, cursor);
      if (
        record.logicalNamespaceSha256 !== logical.namespaceSha256 ||
        record.logicalKeySha256 !== logical.logicalKeySha256 ||
        record.requestSha256 !== logical.requestSha256 ||
        record.model !== logical.model ||
        record.reasoningEffort !== logical.reasoningEffort ||
        record.requestId !== logical.requestId
      ) {
        throw new ReplayMismatchError();
      }
      const completion = {
        requestId: record.requestId,
        created: record.created,
        queueWaitMs: record.queueWaitMs,
        result: record.result,
      };
      cursor.lastResult = completion;
      return completion;
    }
  }

  async commitSuccess(
    logical: LogicalRequest,
    completion: ReplayCompletion,
  ): Promise<void> {
    if (completion.requestId !== logical.requestId) {
      throw new ReplayMismatchError();
    }
    const expectedOrdinal =
      (this.lastOutcomeOrdinal.get(logical.harness) ?? -1) + 1;
    if (logical.ordinal !== expectedOrdinal) {
      throw new ReplayMismatchError();
    }
    const tierHash = requiredResultHash(
      completion.result.credentialTierHmacSha256,
      "tier",
    );
    const capabilityHash = requiredResultHash(
      completion.result.credentialCapabilityHmacSha256,
      "capability",
    );
    requiredResultHash(completion.result.credentialEpochHmacSha256, "epoch");
    this.expectedTierHash = enforceParity(
      this.expectedTierHash,
      tierHash,
      "tier",
    );
    this.expectedCapabilityHash = enforceParity(
      this.expectedCapabilityHash,
      capabilityHash,
      "capability",
    );
    await this.log.append({
      journal_schema_version: 1,
      kind: "completion",
      harness: logical.harness,
      logical_namespace_sha256: logical.namespaceSha256,
      logical_ordinal: logical.ordinal,
      logical_key_sha256: logical.logicalKeySha256,
      request_sha256: logical.requestSha256,
      model: logical.model,
      reasoning_effort: logical.reasoningEffort,
      request_id: completion.requestId,
      created: completion.created,
      queue_wait_ms: completion.queueWaitMs,
      result: completion.result as unknown as JsonObject,
    });
    this.lastOutcomeOrdinal.set(logical.harness, logical.ordinal);
  }

  close(): Promise<void> {
    return this.log.close();
  }

  credentialParity(): {
    tierHmacSha256: string | null;
    capabilityHmacSha256: string | null;
  } {
    return {
      tierHmacSha256: this.expectedTierHash,
      capabilityHmacSha256: this.expectedCapabilityHash,
    };
  }
}

interface ParsedJournalRecord {
  harness: string;
  logicalNamespaceSha256: string;
  logicalOrdinal: number;
  logicalKeySha256: string;
  requestSha256: string;
  model: string;
  reasoningEffort: string | null;
  requestId: string;
  created: number;
  queueWaitMs: number;
  result: ClaudeCompletionResult;
}

function parseJournalRecord(record: JsonObject): ParsedJournalRecord {
  if (record.kind !== "completion" || record.journal_schema_version !== 1) {
    throw new HashChainCorruptionError("Replay journal record kind is invalid.");
  }
  const harness = requiredString(record.harness, "harness");
  const logicalNamespaceSha256 = requiredHash(
    record.logical_namespace_sha256,
    "logical namespace",
  );
  const logicalOrdinal = requiredInteger(
    record.logical_ordinal,
    "logical ordinal",
  );
  const requestSha256 = requiredHash(record.request_sha256, "request");
  const model = requiredString(record.model, "model");
  const reasoningEffort = nullableString(record.reasoning_effort, "reasoning");
  const logicalKeySha256 = requiredHash(
    record.logical_key_sha256,
    "logical key",
  );
  const computed = computeLogicalKeySha256({
    harness,
    namespaceSha256: logicalNamespaceSha256,
    ordinal: logicalOrdinal,
    requestSha256,
    model,
    reasoningEffort,
  });
  if (logicalKeySha256 !== computed) {
    throw new HashChainCorruptionError(
      "Replay journal logical key does not match its canonical fields.",
    );
  }
  const requestId = requiredString(record.request_id, "request id");
  if (requestId !== `logical_${logicalKeySha256}`) {
    throw new HashChainCorruptionError(
      "Replay journal request id does not match its logical key.",
    );
  }
  const created = requiredInteger(record.created, "created timestamp");
  return {
    harness,
    logicalNamespaceSha256,
    logicalOrdinal,
    logicalKeySha256,
    requestSha256,
    model,
    reasoningEffort,
    requestId,
    created,
    queueWaitMs: requiredFiniteNumber(record.queue_wait_ms, "queue wait"),
    result: parseCompletionResult(record.result),
  };
}

function parseCompletionResult(value: unknown): ClaudeCompletionResult {
  if (!isObject(value)) {
    throw new HashChainCorruptionError("Replay completion result is invalid.");
  }
  const toolCallsValue = value.toolCalls;
  if (!Array.isArray(toolCallsValue)) {
    throw new HashChainCorruptionError("Replay tool calls are invalid.");
  }
  const toolCalls = toolCallsValue.map(parseToolCall);
  const usage = parseUsage(value.usage);
  const result: ClaudeCompletionResult = {
    text: requiredStringAllowEmpty(value.text, "completion text"),
    toolCalls,
    model: requiredString(value.model, "effective model"),
    claudeCodeVersion: nullableString(
      value.claudeCodeVersion,
      "Claude Code version",
    ),
    sdkApiKeySource:
      value.sdkApiKeySource === "none"
        ? "none"
        : (() => {
            throw new HashChainCorruptionError(
              "Replay completion API key source is invalid.",
            );
          })(),
    resultSubtype: requiredString(value.resultSubtype, "result subtype"),
    terminalReason: nullableString(value.terminalReason, "terminal reason"),
    subscriptionType: requiredString(value.subscriptionType, "subscription tier"),
    credentialEpochHmacSha256: requiredHash(
      value.credentialEpochHmacSha256,
      "credential epoch",
    ),
    credentialTierHmacSha256: requiredHash(
      value.credentialTierHmacSha256,
      "credential tier",
    ),
    credentialCapabilityHmacSha256: requiredHash(
      value.credentialCapabilityHmacSha256,
      "credential capability",
    ),
    usage,
  };
  return result;
}

function parseToolCall(value: unknown): CapturedToolCall {
  if (!isObject(value) || !isObject(value.arguments)) {
    throw new HashChainCorruptionError("Replay tool call is invalid.");
  }
  return {
    id: requiredString(value.id, "tool call id"),
    name: requiredString(value.name, "tool call name"),
    arguments: value.arguments as JsonObject,
  };
}

function parseUsage(value: unknown): CompletionUsage {
  if (!isObject(value)) {
    throw new HashChainCorruptionError("Replay usage is invalid.");
  }
  return {
    inputTokens: requiredInteger(value.inputTokens, "input tokens"),
    outputTokens: requiredInteger(value.outputTokens, "output tokens"),
    cacheReadInputTokens: requiredInteger(
      value.cacheReadInputTokens,
      "cache read tokens",
    ),
    cacheCreationInputTokens: requiredInteger(
      value.cacheCreationInputTokens,
      "cache creation tokens",
    ),
  };
}

function requiredResultHash(value: string | undefined, label: string): string {
  return requiredHash(value, `credential ${label}`);
}

function enforceParity(
  expected: string | null,
  actual: string | undefined,
  label: string,
): string {
  const normalized = requiredResultHash(actual, label);
  if (expected !== null && expected !== normalized) {
    throw new HashChainCorruptionError(
      `Replay journal credential ${label} parity changed.`,
    );
  }
  return normalized;
}

function requiredHash(value: unknown, label: string): string {
  const normalized = requiredString(value, label);
  if (!HASH_PATTERN.test(normalized)) {
    throw new HashChainCorruptionError(`Replay ${label} hash is invalid.`);
  }
  return normalized;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new HashChainCorruptionError(`Replay ${label} is invalid.`);
  }
  return value;
}

function requiredStringAllowEmpty(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new HashChainCorruptionError(`Replay ${label} is invalid.`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function requiredInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new HashChainCorruptionError(`Replay ${label} is invalid.`);
  }
  return value;
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new HashChainCorruptionError(`Replay ${label} is invalid.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
