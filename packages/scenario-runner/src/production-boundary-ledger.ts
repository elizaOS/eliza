/**
 * Records sanitized, append-only observations around real consumer boundary
 * calls without becoming an alternate state authority. A caller supplies the
 * production adapter, its authoritative readback, the active synthetic-world
 * generation, and the clock; this module only records what those collaborators
 * prove. The JSONL store is deliberately single-writer and relies on the
 * synthetic namespace lease for cross-process exclusion.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactSensitiveText } from "@elizaos/core";

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
  schemaVersion: 1;
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
}

export interface BoundaryObservationLedger {
  append(
    observation: Omit<ProductionBoundaryObservation, "order">,
  ): Promise<ProductionBoundaryObservation>;
  readAll(): Promise<ProductionBoundaryObservation[]>;
}

export interface ObserveProductionBoundaryOptions<TResponse, TReadback> {
  ledger: BoundaryObservationLedger;
  identity: ProductionBoundaryIdentity;
  payload: unknown;
  now: () => Date;
  activeGeneration: () => string;
  invoke: () => Promise<TResponse>;
  classify: (response: TResponse) => BoundaryResultClassification;
  readback: () => Promise<TReadback | null>;
  verifyReadback: (response: TResponse, readback: TReadback) => boolean;
  fault?: BoundaryFaultDirective;
  redactText?: (text: string) => string;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  return normalized;
}

function isoTimestamp(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new Error("boundary observation clock returned an invalid Date");
  }
  return value.toISOString();
}

function sanitizeValue(
  value: unknown,
  redactText: (text: string) => string,
  key?: string,
): unknown {
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
    return value.map((entry) => sanitizeValue(entry, redactText));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = sanitizeValue(entryValue, redactText, entryKey);
    }
    return output;
  }
  return String(value);
}

function safeError(
  error: unknown,
  redactText: (text: string) => string,
): { name: string; message: string } {
  return error instanceof Error
    ? { name: redactText(error.name), message: redactText(error.message) }
    : { name: "Error", message: redactText(String(error)) };
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
      throw new Error(`fault ${fault.kind} is not a pre-call fault`);
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

/**
 * Invoke one real consumer boundary and append the outcome only after its
 * authoritative readback has been checked. An accepted adapter response alone
 * can never produce `succeeded`.
 */
export async function observeProductionBoundary<TResponse, TReadback>(
  options: ObserveProductionBoundaryOptions<TResponse, TReadback>,
): Promise<ProductionBoundaryObservation> {
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
    throw new Error("identity.retry.attempt must be a positive safe integer");
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
    schemaVersion: 1 as const,
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

  const scriptedPreCallFault = preCallFault(options.fault);
  if (scriptedPreCallFault) {
    const classification = preCallFaultClassification(scriptedPreCallFault);
    return options.ledger.append({
      ...base,
      completedAt: isoTimestamp(options.now),
      boundaryCalled: false,
      ...classification,
      ...(scriptedPreCallFault.retryAfterMs !== undefined
        ? { retryAfterMs: scriptedPreCallFault.retryAfterMs }
        : {}),
      error: safeError(new Error(scriptedPreCallFault.message), redactText),
    });
  }

  let response: TResponse;
  try {
    response = await options.invoke();
  } catch (error) {
    return options.ledger.append({
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

  const responseSha256 = canonicalSha256(
    sanitizeValue(response, redactText),
    "sanitizedBoundaryResponse",
  );
  const classification = options.classify(response);
  let readback: TReadback | null = null;
  let readbackError: unknown;
  try {
    readback = await options.readback();
  } catch (error) {
    readbackError = error;
  }

  const readbackSha256 =
    readback === null
      ? undefined
      : canonicalSha256(
          sanitizeValue(readback, redactText),
          "sanitizedBoundaryReadback",
        );
  const activeGeneration = options.activeGeneration();
  const scriptedPostCallResult = postCallFaultResult(options.fault);
  let result: BoundaryObservationResult;
  if (
    activeGeneration !== identity.generation ||
    scriptedPostCallResult === "stale_completion"
  ) {
    result = "stale_completion";
  } else if (scriptedPostCallResult) {
    result = scriptedPostCallResult;
  } else if (classification.acceptance === "rejected") {
    result = "rejected";
  } else if (classification.acceptance === "unknown") {
    result = "unknown";
  } else if (readbackError || readback === null) {
    result = "readback_missing";
  } else if (!options.verifyReadback(response, readback)) {
    result = "readback_mismatch";
  } else {
    result = "succeeded";
  }

  return options.ledger.append({
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
    ...(readbackError
      ? { error: safeError(readbackError, redactText) }
      : options.fault
        ? { error: safeError(new Error(options.fault.message), redactText) }
        : {}),
  });
}

function parseLedgerLine(
  line: string,
  lineNumber: number,
): ProductionBoundaryObservation {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`invalid boundary ledger JSON at line ${lineNumber}`, {
      cause: error,
    });
  }
  if (!value || typeof value !== "object") {
    throw new Error(`invalid boundary ledger record at line ${lineNumber}`);
  }
  const record = value as Partial<ProductionBoundaryObservation>;
  if (record.schemaVersion !== 1 || record.order !== lineNumber) {
    throw new Error(`invalid boundary ledger ordering at line ${lineNumber}`);
  }
  return record as ProductionBoundaryObservation;
}

/** Durable JSONL observation store. Production state remains authoritative. */
export class JsonlBoundaryObservationLedger
  implements BoundaryObservationLedger
{
  readonly #filePath: string;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = requireNonEmpty(filePath, "filePath");
  }

  async readAll(): Promise<ProductionBoundaryObservation[]> {
    let contents: string;
    try {
      contents = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lines = contents.split("\n").filter((line) => line.length > 0);
    return lines.map((line, index) => parseLedgerLine(line, index + 1));
  }

  append(
    observation: Omit<ProductionBoundaryObservation, "order">,
  ): Promise<ProductionBoundaryObservation> {
    const appendPromise = this.#pending.then(async () => {
      const records = await this.readAll();
      if (
        records.some(
          (record) => record.observationId === observation.observationId,
        )
      ) {
        throw new Error(
          `boundary observation ${observation.observationId} already exists`,
        );
      }
      const record = { ...observation, order: records.length + 1 };
      await mkdir(dirname(this.#filePath), { recursive: true });
      await writeFile(this.#filePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "a",
        mode: 0o600,
      });
      return record;
    });
    this.#pending = appendPromise.catch(() => undefined);
    return appendPromise;
  }
}
