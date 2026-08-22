/**
 * Records sanitized, append-only observations around real consumer boundary
 * calls without becoming an alternate state authority. A caller supplies the
 * production adapter, its authoritative readback, the active synthetic-world
 * generation, and the clock; this module only records what those collaborators
 * prove. The JSONL store is deliberately single-writer and relies on the
 * synthetic namespace lease for cross-process exclusion.
 */

import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ElizaError, redactSensitiveText } from "@elizaos/core";

import { canonicalSha256 } from "./provider-qualified/manifest.ts";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|session|token)/i;

export type BoundaryFaultKind =
  | "timeout"
  | "retryable_failure"
  | "permanent_failure"
  | "rate_limit"
  | "partial_failure"
  | "ambiguous_dispatch"
  | "stale_completion";

export interface BoundaryFaultDirective {
  kind: BoundaryFaultKind;
  message: string;
  retryAfterMs?: number;
}

export interface BoundaryRetryLineage {
  attempt: number;
  retryOfObservationId?: string;
}

export interface ProductionBoundaryIdentity {
  surface: string;
  target: string;
  idempotencyKey: string;
  generation: string;
  workerId?: string;
  taskId?: string;
  retry: BoundaryRetryLineage;
}

export type BoundaryAcceptance = "accepted" | "rejected" | "unknown";

export interface BoundaryResultClassification {
  acceptance: BoundaryAcceptance;
  code: string;
  retryable: boolean;
}

export type BoundaryObservationResult =
  | "succeeded"
  | "rejected"
  | "unknown"
  | "timeout"
  | "rate_limited"
  | "partial_failure"
  | "readback_missing"
  | "readback_mismatch"
  | "stale_completion";

export interface ProductionBoundaryObservation {
  schemaVersion: 2;
  observationId: string;
  order: number;
  surface: string;
  target: string;
  payloadSha256: string;
  idempotencyKey: string;
  generation: string;
  workerId?: string;
  taskId?: string;
  attempt: number;
  retryOfObservationId?: string;
  startedAt: string;
  completedAt: string;
  boundaryCalled: boolean;
  acceptance: BoundaryAcceptance;
  result: BoundaryObservationResult;
  resultCode: string;
  retryable: boolean;
  retryAfterMs?: number;
  responseSha256?: string;
  readbackSha256?: string;
  error?: {
    name: string;
    message: string;
  };
  previousRecordSha256: string | null;
  recordSha256: string;
}

export interface BoundaryObservationLedger {
  readAll(): Promise<ProductionBoundaryObservation[]>;
}

export interface BoundaryGenerationFence {
  /**
   * Runs the callback while reset/rollover is excluded. The production-owned
   * guard must sample authoritative generation state on every `isCurrent`
   * call, including after an external boundary invocation. Acquisition errors
   * must reject before `operation` starts. Once admitted, the fence must settle
   * with `operation`; it may not introduce a new post-callback rejection.
   */
  withGeneration<T>(
    expectedGeneration: string,
    operation: (guard: BoundaryGenerationGuard) => Promise<T>,
  ): Promise<T>;
}

export interface BoundaryGenerationGuard {
  isCurrent(): Promise<boolean>;
}

export interface ObserveProductionBoundaryOptions<TResponse, TReadback> {
  ledger: BoundaryObservationLedger;
  identity: ProductionBoundaryIdentity;
  payload: unknown;
  now: () => Date;
  generationFence: BoundaryGenerationFence;
  invoke: () => Promise<TResponse>;
  classify: (response: TResponse) => BoundaryResultClassification;
  readback: () => Promise<TReadback | null>;
  verifyReadback: (response: TResponse, readback: TReadback) => boolean;
  fault?: BoundaryFaultDirective;
  redactText?: (text: string) => string;
}

type PendingObservation = Omit<
  ProductionBoundaryObservation,
  "order" | "previousRecordSha256" | "recordSha256"
>;

const ledgerAppenders = new WeakMap<
  BoundaryObservationLedger,
  (observation: PendingObservation) => Promise<ProductionBoundaryObservation>
>();

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ElizaError(`${field} must be non-empty`, {
      code: "BOUNDARY_OBSERVATION_INVALID",
      context: { field },
    });
  }
  return normalized;
}

function isoTimestamp(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new ElizaError(
      "boundary observation clock returned an invalid Date",
      {
        code: "BOUNDARY_OBSERVATION_INVALID_CLOCK",
      },
    );
  }
  return value.toISOString();
}

function sanitizeValue(
  value: unknown,
  redactText: (text: string) => string,
  key?: string,
  state: { seen: WeakSet<object>; nodes: number } = {
    seen: new WeakSet<object>(),
    nodes: 0,
  },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (depth > 64 || state.nodes > 10_000) {
    throw new ElizaError("boundary evidence exceeds sanitization limits", {
      code: "BOUNDARY_EVIDENCE_TOO_COMPLEX",
      context: { depth, nodes: state.nodes },
    });
  }
  if (key && SENSITIVE_KEY.test(key)) return REDACTED;
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (state.seen.has(value)) {
      throw new ElizaError("boundary evidence contains a cycle", {
        code: "BOUNDARY_EVIDENCE_CYCLE",
      });
    }
    state.seen.add(value);
    const output = value.map((entry) =>
      sanitizeValue(entry, redactText, undefined, state, depth + 1),
    );
    state.seen.delete(value);
    return output;
  }
  if (typeof value === "object") {
    if (state.seen.has(value)) {
      throw new ElizaError("boundary evidence contains a cycle", {
        code: "BOUNDARY_EVIDENCE_CYCLE",
      });
    }
    state.seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = sanitizeValue(
        entryValue,
        redactText,
        entryKey,
        state,
        depth + 1,
      );
    }
    state.seen.delete(value);
    return output;
  }
  return String(value);
}

function safeError(
  error: unknown,
  redactText: (text: string) => string,
): { name: string; message: string } {
  const sanitized =
    error instanceof Error
      ? { name: redactText(error.name), message: redactText(error.message) }
      : { name: "Error", message: redactText(String(error)) };
  return {
    name: sanitized.name || "Error",
    message: sanitized.message || "unspecified boundary collaborator error",
  };
}

function preCallFault(
  fault: BoundaryFaultDirective | undefined,
): BoundaryFaultDirective | null {
  if (!fault) return null;
  return fault.kind === "timeout" ||
    fault.kind === "retryable_failure" ||
    fault.kind === "permanent_failure" ||
    fault.kind === "rate_limit"
    ? fault
    : null;
}

function preCallFaultClassification(fault: BoundaryFaultDirective): {
  acceptance: BoundaryAcceptance;
  result: BoundaryObservationResult;
  resultCode: string;
  retryable: boolean;
} {
  switch (fault.kind) {
    case "timeout":
      return {
        acceptance: "unknown",
        result: "timeout",
        resultCode: "synthetic_timeout",
        retryable: true,
      };
    case "rate_limit":
      return {
        acceptance: "rejected",
        result: "rate_limited",
        resultCode: "synthetic_rate_limit",
        retryable: true,
      };
    case "retryable_failure":
      return {
        acceptance: "rejected",
        result: "rejected",
        resultCode: "synthetic_retryable_failure",
        retryable: true,
      };
    case "permanent_failure":
      return {
        acceptance: "rejected",
        result: "rejected",
        resultCode: "synthetic_permanent_failure",
        retryable: false,
      };
    default:
      throw new ElizaError(`fault ${fault.kind} is not a pre-call fault`, {
        code: "BOUNDARY_OBSERVATION_INVALID_FAULT",
        context: { kind: fault.kind },
      });
  }
}

function postCallFaultResult(
  fault: BoundaryFaultDirective | undefined,
): BoundaryObservationResult | null {
  if (!fault) return null;
  switch (fault.kind) {
    case "partial_failure":
      return "partial_failure";
    case "ambiguous_dispatch":
      return "unknown";
    case "stale_completion":
      return "stale_completion";
    default:
      return null;
  }
}

function appendObservation(
  ledger: BoundaryObservationLedger,
  observation: PendingObservation,
): Promise<ProductionBoundaryObservation> {
  const append = ledgerAppenders.get(ledger);
  if (!append) {
    throw new ElizaError(
      "boundary observation ledger does not expose the private writer capability",
      { code: "BOUNDARY_LEDGER_WRITER_UNAVAILABLE" },
    );
  }
  return append(observation);
}

function requireClassification(
  value: BoundaryResultClassification,
): BoundaryResultClassification {
  if (
    (value.acceptance !== "accepted" &&
      value.acceptance !== "rejected" &&
      value.acceptance !== "unknown") ||
    typeof value.code !== "string" ||
    value.code.trim().length === 0 ||
    typeof value.retryable !== "boolean"
  ) {
    throw new ElizaError("boundary classifier returned an invalid result", {
      code: "BOUNDARY_CLASSIFIER_INVALID",
    });
  }
  return value;
}

/**
 * Invoke one real consumer boundary and append the outcome only after its
 * authoritative readback has been checked. An accepted adapter response alone
 * can never produce `succeeded`.
 */
export async function observeProductionBoundary<TResponse, TReadback>(
  options: ObserveProductionBoundaryOptions<TResponse, TReadback>,
): Promise<ProductionBoundaryObservation> {
  if (!ledgerAppenders.has(options.ledger)) {
    throw new ElizaError(
      "boundary observation ledger does not expose the private writer capability",
      { code: "BOUNDARY_LEDGER_WRITER_UNAVAILABLE" },
    );
  }
  const redactText = (text: string) =>
    redactSensitiveText(options.redactText ? options.redactText(text) : text);
  const identity = options.identity;
  const surface = redactText(
    requireNonEmpty(identity.surface, "identity.surface"),
  );
  const target = redactText(
    requireNonEmpty(identity.target, "identity.target"),
  );
  const idempotencyKey = redactText(
    requireNonEmpty(identity.idempotencyKey, "identity.idempotencyKey"),
  );
  const generation = redactText(
    requireNonEmpty(identity.generation, "identity.generation"),
  );
  if (
    !Number.isSafeInteger(identity.retry.attempt) ||
    identity.retry.attempt < 1
  ) {
    throw new ElizaError(
      "identity.retry.attempt must be a positive safe integer",
      { code: "BOUNDARY_OBSERVATION_INVALID_RETRY" },
    );
  }

  const startedAt = isoTimestamp(options.now);
  const payloadSha256 = canonicalSha256(
    sanitizeValue(options.payload, redactText),
    "sanitizedBoundaryPayload",
  );
  const observationId = canonicalSha256({
    generation,
    idempotencyKey,
    attempt: identity.retry.attempt,
    surface,
    target,
  });
  const base = {
    schemaVersion: 2 as const,
    observationId,
    surface,
    target,
    payloadSha256,
    idempotencyKey,
    generation,
    ...(identity.workerId ? { workerId: redactText(identity.workerId) } : {}),
    ...(identity.taskId ? { taskId: redactText(identity.taskId) } : {}),
    attempt: identity.retry.attempt,
    ...(identity.retry.retryOfObservationId
      ? {
          retryOfObservationId: redactText(identity.retry.retryOfObservationId),
        }
      : {}),
    startedAt,
  };

  try {
    return await options.generationFence.withGeneration(
      identity.generation,
      async (guard) => {
        if (!(await guard.isCurrent())) {
          return appendObservation(options.ledger, {
            ...base,
            completedAt: isoTimestamp(options.now),
            boundaryCalled: false,
            acceptance: "unknown",
            result: "stale_completion",
            resultCode: "stale_generation_before_invoke",
            retryable: false,
          });
        }

        const scriptedPreCallFault = preCallFault(options.fault);
        if (scriptedPreCallFault) {
          const classification =
            preCallFaultClassification(scriptedPreCallFault);
          return appendObservation(options.ledger, {
            ...base,
            completedAt: isoTimestamp(options.now),
            boundaryCalled: false,
            ...classification,
            ...(scriptedPreCallFault.retryAfterMs !== undefined
              ? { retryAfterMs: scriptedPreCallFault.retryAfterMs }
              : {}),
            error: safeError(
              new ElizaError(scriptedPreCallFault.message, {
                code: "BOUNDARY_OBSERVATION_SCRIPTED_FAULT",
                context: { kind: scriptedPreCallFault.kind },
              }),
              redactText,
            ),
          });
        }

        let response: TResponse;
        try {
          response = await options.invoke();
        } catch (error) {
          // error-policy:J1 the consumer boundary translates an invocation
          // failure into a sanitized, non-success observation.
          return appendObservation(options.ledger, {
            ...base,
            completedAt: isoTimestamp(options.now),
            boundaryCalled: true,
            acceptance: "unknown",
            result: "unknown",
            resultCode: "boundary_threw",
            retryable: false,
            error: safeError(error, redactText),
          });
        }

        let responseSha256: string;
        try {
          responseSha256 = canonicalSha256(
            sanitizeValue(response, redactText),
            "sanitizedBoundaryResponse",
          );
        } catch (error) {
          // error-policy:J1 response evidence failures after invocation remain
          // visible as sanitized unknown attempts.
          return appendObservation(options.ledger, {
            ...base,
            completedAt: isoTimestamp(options.now),
            boundaryCalled: true,
            acceptance: "unknown",
            result: "unknown",
            resultCode: "response_evidence_threw",
            retryable: false,
            error: safeError(error, redactText),
          });
        }

        let currentAfterInvoke: boolean;
        try {
          currentAfterInvoke = await guard.isCurrent();
        } catch (error) {
          // error-policy:J1 authoritative generation revalidation failed after
          // the external effect, so the attempt is durably unknown.
          return appendObservation(options.ledger, {
            ...base,
            completedAt: isoTimestamp(options.now),
            boundaryCalled: true,
            acceptance: "unknown",
            result: "unknown",
            resultCode: "generation_revalidation_threw",
            retryable: false,
            responseSha256,
            error: safeError(error, redactText),
          });
        }
        if (!currentAfterInvoke) {
          return appendObservation(options.ledger, {
            ...base,
            completedAt: isoTimestamp(options.now),
            boundaryCalled: true,
            acceptance: "unknown",
            result: "stale_completion",
            resultCode: "stale_generation_after_invoke",
            retryable: false,
            responseSha256,
          });
        }
        let classification: BoundaryResultClassification;
        try {
          classification = requireClassification(options.classify(response));
        } catch (error) {
          // error-policy:J1 a classifier failure after a real invocation is
          // persisted as unknown so the attempt cannot disappear or succeed.
          return appendObservation(options.ledger, {
            ...base,
            completedAt: isoTimestamp(options.now),
            boundaryCalled: true,
            acceptance: "unknown",
            result: "unknown",
            resultCode: "classifier_threw",
            retryable: false,
            responseSha256,
            error: safeError(error, redactText),
          });
        }
        let readback: TReadback | null = null;
        try {
          readback = await options.readback();
        } catch (error) {
          // error-policy:J1 readback collaborator failure after invocation is
          // translated into a sanitized unknown observation.
          return appendObservation(options.ledger, {
            ...base,
            completedAt: isoTimestamp(options.now),
            boundaryCalled: true,
            acceptance: "unknown",
            result: "unknown",
            resultCode: "readback_threw",
            retryable: false,
            responseSha256,
            error: safeError(error, redactText),
          });
        }

        let readbackSha256: string | undefined;
        try {
          readbackSha256 =
            readback === null
              ? undefined
              : canonicalSha256(
                  sanitizeValue(readback, redactText),
                  "sanitizedBoundaryReadback",
                );
        } catch (error) {
          // error-policy:J1 malformed readback evidence after invocation is a
          // visible sanitized unknown attempt.
          return appendObservation(options.ledger, {
            ...base,
            completedAt: isoTimestamp(options.now),
            boundaryCalled: true,
            acceptance: "unknown",
            result: "unknown",
            resultCode: "readback_evidence_threw",
            retryable: false,
            responseSha256,
            error: safeError(error, redactText),
          });
        }
        const scriptedPostCallResult = postCallFaultResult(options.fault);
        let result: BoundaryObservationResult;
        if (scriptedPostCallResult === "stale_completion") {
          result = "stale_completion";
        } else if (scriptedPostCallResult) {
          result = scriptedPostCallResult;
        } else if (classification.acceptance === "rejected") {
          result = "rejected";
        } else if (classification.acceptance === "unknown") {
          result = "unknown";
        } else if (readback === null) {
          result = "readback_missing";
        } else {
          try {
            result = options.verifyReadback(response, readback)
              ? "succeeded"
              : "readback_mismatch";
          } catch (error) {
            // error-policy:J1 verifier failure after invocation is translated
            // into a sanitized unknown observation.
            return appendObservation(options.ledger, {
              ...base,
              completedAt: isoTimestamp(options.now),
              boundaryCalled: true,
              acceptance: "unknown",
              result: "unknown",
              resultCode: "verifier_threw",
              retryable: false,
              responseSha256,
              ...(readbackSha256 ? { readbackSha256 } : {}),
              error: safeError(error, redactText),
            });
          }
        }

        return appendObservation(options.ledger, {
          ...base,
          completedAt: isoTimestamp(options.now),
          boundaryCalled: true,
          acceptance: classification.acceptance,
          result,
          resultCode:
            scriptedPostCallResult === "partial_failure"
              ? "synthetic_partial_failure"
              : scriptedPostCallResult === "unknown"
                ? "synthetic_ambiguous_dispatch"
                : result === "stale_completion"
                  ? "stale_generation"
                  : redactText(classification.code),
          retryable: classification.retryable,
          ...(options.fault?.retryAfterMs !== undefined
            ? { retryAfterMs: options.fault.retryAfterMs }
            : {}),
          responseSha256,
          ...(readbackSha256 ? { readbackSha256 } : {}),
          ...(options.fault
            ? {
                error: safeError(
                  new ElizaError(options.fault.message, {
                    code: "BOUNDARY_OBSERVATION_SCRIPTED_FAULT",
                    context: { kind: options.fault.kind },
                  }),
                  redactText,
                ),
              }
            : {}),
        });
      },
    );
  } catch (error) {
    // error-policy:J2 failures outside the admitted callback are generation
    // lease acquisition/ownership failures; invocation and append never start.
    if (error instanceof ElizaError) throw error;
    throw new ElizaError("production generation fence failed", {
      code: "BOUNDARY_GENERATION_FENCE_FAILED",
      cause: error,
      context: { generation: identity.generation },
    });
  }
}

const ACCEPTANCES = new Set<BoundaryAcceptance>([
  "accepted",
  "rejected",
  "unknown",
]);
const RESULTS = new Set<BoundaryObservationResult>([
  "succeeded",
  "rejected",
  "unknown",
  "timeout",
  "rate_limited",
  "partial_failure",
  "readback_missing",
  "readback_mismatch",
  "stale_completion",
]);
const RECORD_KEYS = new Set([
  "schemaVersion",
  "observationId",
  "order",
  "surface",
  "target",
  "payloadSha256",
  "idempotencyKey",
  "generation",
  "workerId",
  "taskId",
  "attempt",
  "retryOfObservationId",
  "startedAt",
  "completedAt",
  "boundaryCalled",
  "acceptance",
  "result",
  "resultCode",
  "retryable",
  "retryAfterMs",
  "responseSha256",
  "readbackSha256",
  "error",
  "previousRecordSha256",
  "recordSha256",
]);
const REQUIRED_RECORD_KEYS = new Set([
  "schemaVersion",
  "observationId",
  "order",
  "surface",
  "target",
  "payloadSha256",
  "idempotencyKey",
  "generation",
  "attempt",
  "startedAt",
  "completedAt",
  "boundaryCalled",
  "acceptance",
  "result",
  "resultCode",
  "retryable",
  "previousRecordSha256",
  "recordSha256",
]);
const SHA256 = /^[0-9a-f]{64}$/;

function ledgerError(
  message: string,
  lineNumber: number,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code: "BOUNDARY_LEDGER_CORRUPT",
    context: { lineNumber },
    ...(cause === undefined ? {} : { cause }),
  });
}

function parseLedgerLine(
  line: string,
  lineNumber: number,
  previousRecordSha256: string | null,
): ProductionBoundaryObservation {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    // error-policy:J2 JSON parse context is preserved and rethrown as the
    // typed durable-ledger corruption boundary.
    throw ledgerError(
      `invalid boundary ledger JSON at line ${lineNumber}`,
      lineNumber,
      error,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ledgerError(
      `invalid boundary ledger record at line ${lineNumber}`,
      lineNumber,
    );
  }
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some((key) => !RECORD_KEYS.has(key)) ||
    [...REQUIRED_RECORD_KEYS].some((key) => !(key in raw))
  ) {
    throw ledgerError(
      `unknown boundary ledger field at line ${lineNumber}`,
      lineNumber,
    );
  }
  const stringFields = [
    "observationId",
    "surface",
    "target",
    "payloadSha256",
    "idempotencyKey",
    "generation",
    "startedAt",
    "completedAt",
    "resultCode",
    "recordSha256",
  ];
  if (
    raw.schemaVersion !== 2 ||
    raw.order !== lineNumber ||
    stringFields.some(
      (field) =>
        typeof raw[field] !== "string" || (raw[field] as string).trim() === "",
    ) ||
    typeof raw.boundaryCalled !== "boolean" ||
    typeof raw.retryable !== "boolean" ||
    !Number.isSafeInteger(raw.attempt) ||
    (raw.attempt as number) < 1 ||
    !ACCEPTANCES.has(raw.acceptance as BoundaryAcceptance) ||
    !RESULTS.has(raw.result as BoundaryObservationResult)
  ) {
    throw ledgerError(
      `invalid boundary ledger field types at line ${lineNumber}`,
      lineNumber,
    );
  }
  for (const field of [
    "workerId",
    "taskId",
    "retryOfObservationId",
    "responseSha256",
    "readbackSha256",
  ]) {
    if (
      raw[field] !== undefined &&
      (typeof raw[field] !== "string" || (raw[field] as string).trim() === "")
    ) {
      throw ledgerError(`invalid ${field} at line ${lineNumber}`, lineNumber);
    }
  }
  if (
    (raw.retryAfterMs !== undefined &&
      (!Number.isSafeInteger(raw.retryAfterMs) ||
        (raw.retryAfterMs as number) < 0)) ||
    (raw.error !== undefined &&
      (!raw.error ||
        typeof raw.error !== "object" ||
        Array.isArray(raw.error) ||
        Object.keys(raw.error).some(
          (key) => key !== "name" && key !== "message",
        ) ||
        Object.keys(raw.error).length !== 2 ||
        typeof (raw.error as Record<string, unknown>).name !== "string" ||
        (raw.error as Record<string, string>).name.trim() === "" ||
        typeof (raw.error as Record<string, unknown>).message !== "string" ||
        (raw.error as Record<string, string>).message.trim() === ""))
  ) {
    throw ledgerError(
      `invalid optional boundary ledger fields at line ${lineNumber}`,
      lineNumber,
    );
  }
  for (const field of [
    "observationId",
    "payloadSha256",
    "recordSha256",
    ...(raw.retryOfObservationId === undefined ? [] : ["retryOfObservationId"]),
    ...(raw.responseSha256 === undefined ? [] : ["responseSha256"]),
    ...(raw.readbackSha256 === undefined ? [] : ["readbackSha256"]),
  ]) {
    if (!SHA256.test(raw[field] as string)) {
      throw ledgerError(`invalid ${field} at line ${lineNumber}`, lineNumber);
    }
  }
  if (
    raw.previousRecordSha256 !== previousRecordSha256 ||
    (raw.previousRecordSha256 !== null &&
      !SHA256.test(raw.previousRecordSha256 as string))
  ) {
    throw ledgerError(
      `broken boundary ledger hash chain at line ${lineNumber}`,
      lineNumber,
    );
  }
  if (raw.readbackSha256 !== undefined && raw.responseSha256 === undefined) {
    throw ledgerError(
      `readback evidence lacks response evidence at line ${lineNumber}`,
      lineNumber,
    );
  }
  for (const field of ["startedAt", "completedAt"]) {
    const timestamp = raw[field] as string;
    if (
      !Number.isFinite(Date.parse(timestamp)) ||
      new Date(timestamp).toISOString() !== timestamp
    ) {
      throw ledgerError(`invalid ${field} at line ${lineNumber}`, lineNumber);
    }
  }
  const expectedObservationId = canonicalSha256({
    generation: raw.generation,
    idempotencyKey: raw.idempotencyKey,
    attempt: raw.attempt,
    surface: raw.surface,
    target: raw.target,
  });
  if (raw.observationId !== expectedObservationId) {
    throw ledgerError(
      `invalid observation identity at line ${lineNumber}`,
      lineNumber,
    );
  }
  if (
    raw.result === "succeeded" &&
    (!raw.boundaryCalled ||
      raw.acceptance !== "accepted" ||
      raw.retryable ||
      typeof raw.responseSha256 !== "string" ||
      typeof raw.readbackSha256 !== "string" ||
      raw.error !== undefined)
  ) {
    throw ledgerError(
      `impossible successful observation at line ${lineNumber}`,
      lineNumber,
    );
  }
  if (
    Date.parse(raw.completedAt as string) < Date.parse(raw.startedAt as string)
  ) {
    throw ledgerError(
      `observation completed before it started at line ${lineNumber}`,
      lineNumber,
    );
  }
  if (
    raw.boundaryCalled === false &&
    (raw.responseSha256 !== undefined || raw.readbackSha256 !== undefined)
  ) {
    throw ledgerError(
      `uncalled boundary has response evidence at line ${lineNumber}`,
      lineNumber,
    );
  }
  const { recordSha256, ...recordWithoutHash } = raw;
  if (
    recordSha256 !==
    canonicalSha256(recordWithoutHash, "boundaryObservationRecord")
  ) {
    throw ledgerError(`invalid record hash at line ${lineNumber}`, lineNumber);
  }
  return raw as unknown as ProductionBoundaryObservation;
}

/** Durable JSONL observation store. Production state remains authoritative. */
export class JsonlBoundaryObservationLedger
  implements BoundaryObservationLedger
{
  readonly #filePath: string;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = requireNonEmpty(filePath, "filePath");
    ledgerAppenders.set(this, (observation) => this.#append(observation));
  }

  async #readFromDisk(): Promise<ProductionBoundaryObservation[]> {
    let contents: string;
    try {
      contents = await readFile(this.#filePath, "utf8");
    } catch (error) {
      // error-policy:J3 a missing ledger is the explicit empty initial state;
      // every other filesystem failure remains fatal.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ElizaError("failed to read boundary observation ledger", {
        code: "BOUNDARY_LEDGER_READ_FAILED",
        cause: error,
        context: { filePath: this.#filePath },
      });
    }
    if (contents === "") return [];
    if (!contents.endsWith("\n")) {
      throw ledgerError("boundary ledger has a truncated final frame", 0);
    }
    const lines = contents.slice(0, -1).split("\n");
    if (lines.some((line) => line.length === 0)) {
      throw ledgerError("boundary ledger contains a blank frame", 0);
    }
    const records: ProductionBoundaryObservation[] = [];
    let previousRecordSha256: string | null = null;
    for (const [index, line] of lines.entries()) {
      const record = parseLedgerLine(line, index + 1, previousRecordSha256);
      records.push(record);
      previousRecordSha256 = record.recordSha256;
    }
    return records;
  }

  async readAll(): Promise<ProductionBoundaryObservation[]> {
    await this.#pending;
    return this.#readFromDisk();
  }

  #append(
    observation: PendingObservation,
  ): Promise<ProductionBoundaryObservation> {
    const appendPromise = this.#pending.then(async () => {
      const records = await this.#readFromDisk();
      if (
        records.some(
          (record) => record.observationId === observation.observationId,
        )
      ) {
        throw new ElizaError(
          `boundary observation ${observation.observationId} already exists`,
          {
            code: "BOUNDARY_LEDGER_DUPLICATE_OBSERVATION",
            context: { observationId: observation.observationId },
          },
        );
      }
      const recordWithoutHash = {
        ...observation,
        order: records.length + 1,
        previousRecordSha256: records.at(-1)?.recordSha256 ?? null,
      };
      const record: ProductionBoundaryObservation = {
        ...recordWithoutHash,
        recordSha256: canonicalSha256(
          recordWithoutHash,
          "boundaryObservationRecord",
        ),
      };
      parseLedgerLine(
        JSON.stringify(record),
        record.order,
        record.previousRecordSha256,
      );
      try {
        await mkdir(dirname(this.#filePath), { recursive: true });
        const handle = await open(this.#filePath, "a", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        const directoryHandle = await open(dirname(this.#filePath), "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch (error) {
        // error-policy:J2 durable append failures preserve the filesystem
        // cause and never return a successful observation.
        throw new ElizaError("failed to append boundary observation", {
          code: "BOUNDARY_LEDGER_APPEND_FAILED",
          cause: error,
          context: {
            filePath: this.#filePath,
            observationId: observation.observationId,
          },
        });
      }
      return record;
    });
    // error-policy:J5 the caller observes appendPromise; this normalized tail
    // only keeps later single-writer appends from inheriting its rejection.
    this.#pending = appendPromise.then(
      () => undefined,
      () => undefined,
    );
    return appendPromise;
  }
}
