/** Strict browser boundary for authoritative billable-resource cancellation receipts. */

import { apiWithStatusAndHeaders } from "../../lib/api-client";

const DURABLE_CANCEL_VERSION_HEADER = "X-Eliza-Billing-Cancel-Version";

export type BillingCancellationResourceType = "container" | "agent_sandbox";
export type BillingCancellationStatus =
  | "accepted"
  | "provider_confirmed"
  | "conflict"
  | "terminal_attention";

export interface BillingCancellationReceipt {
  receiptId: string;
  jobId: string;
  resourceType: BillingCancellationResourceType;
  resourceId: string;
  action: "stop";
  expectedLifecycleRevision: number;
  status: BillingCancellationStatus;
  computeStopped: boolean;
  providerStopped: boolean;
  retainedBackupBilling: {
    status: "not_applicable" | "pending" | "none" | "billable";
    ratePerHour: number | null;
  };
  infrastructureStatus:
    | "queued"
    | "provider_confirmed"
    | "superseded"
    | "terminal_attention";
  acceptedAt: string;
  pollEndpoint: string;
}

export interface BillingCancellationResult {
  disposition: "accepted" | "same_key_replay" | "same_command";
  receipt: BillingCancellationReceipt;
}

export interface RequestBillingCancellationInput {
  endpoint: string;
  resourceType: BillingCancellationResourceType;
  resourceId: string;
  expectedLifecycleRevision: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export class BillingCancellationHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "BillingCancellationHttpError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const RECEIPT_STATUSES = new Set<BillingCancellationStatus>([
  "accepted",
  "provider_confirmed",
  "conflict",
  "terminal_attention",
]);
const DISPOSITIONS = new Set<BillingCancellationResult["disposition"]>([
  "accepted",
  "same_key_replay",
  "same_command",
]);

function invalidResponse(): never {
  throw new Error("Billing cancellation response is invalid.");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidResponse();
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidResponse();
  }
  return value;
}

function uuid(value: unknown): string {
  const parsed = nonEmptyString(value);
  if (!UUID_PATTERN.test(parsed)) return invalidResponse();
  return parsed.toLowerCase();
}

function safeRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalidResponse();
  }
  return Number(value);
}

function canonicalIsoTimestamp(value: unknown): string {
  if (typeof value !== "string") return invalidResponse();
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    return invalidResponse();
  }
  return value;
}

function cancellationEndpoint(resourceId: string): string {
  return `/api/v1/billing/resources/${resourceId}/cancel`;
}

function cancellationRequestEndpoint(
  resourceId: string,
  resourceType: BillingCancellationResourceType,
): string {
  return `${cancellationEndpoint(resourceId)}?resourceType=${resourceType}`;
}

function parsePollEndpoint(
  value: unknown,
  resourceId: string,
  receiptId: string,
): string {
  const endpoint = nonEmptyString(value);
  const expected = `${cancellationEndpoint(resourceId)}?receiptId=${receiptId}`;
  if (endpoint !== expected) return invalidResponse();
  return endpoint;
}

function parseReceipt(value: unknown): BillingCancellationReceipt {
  const record = asRecord(value);
  const receiptId = uuid(record.receiptId);
  const resourceId = uuid(record.resourceId);
  const resourceType = record.resourceType;
  if (resourceType !== "container" && resourceType !== "agent_sandbox") {
    return invalidResponse();
  }
  if (record.action !== "stop") return invalidResponse();
  if (
    typeof record.status !== "string" ||
    !RECEIPT_STATUSES.has(record.status as BillingCancellationStatus)
  ) {
    return invalidResponse();
  }
  const status = record.status as BillingCancellationStatus;
  const invariant = {
    accepted: { stopped: false, infrastructureStatus: "queued" },
    provider_confirmed: {
      stopped: true,
      infrastructureStatus: "provider_confirmed",
    },
    conflict: { stopped: false, infrastructureStatus: "superseded" },
    terminal_attention: {
      stopped: false,
      infrastructureStatus: "terminal_attention",
    },
  }[status] as {
    stopped: boolean;
    infrastructureStatus: BillingCancellationReceipt["infrastructureStatus"];
  };
  if (
    record.computeStopped !== invariant.stopped ||
    record.providerStopped !== invariant.stopped ||
    record.infrastructureStatus !== invariant.infrastructureStatus
  ) {
    return invalidResponse();
  }
  const retainedRecord = asRecord(record.retainedBackupBilling);
  const retainedStatus = retainedRecord.status;
  const retainedRate = retainedRecord.ratePerHour;
  const retainedBackupBilling: BillingCancellationReceipt["retainedBackupBilling"] =
    resourceType === "container"
      ? retainedStatus === "not_applicable" && retainedRate === null
        ? { status: "not_applicable", ratePerHour: null }
        : invalidResponse()
      : status === "provider_confirmed"
        ? retainedStatus === "none" && retainedRate === null
          ? { status: "none", ratePerHour: null }
          : retainedStatus === "billable" &&
              typeof retainedRate === "number" &&
              Number.isFinite(retainedRate) &&
              retainedRate > 0
            ? { status: "billable", ratePerHour: retainedRate }
            : invalidResponse()
        : retainedStatus === "pending" &&
            typeof retainedRate === "number" &&
            Number.isFinite(retainedRate) &&
            retainedRate > 0
          ? { status: "pending", ratePerHour: retainedRate }
          : invalidResponse();

  return {
    receiptId,
    jobId: uuid(record.jobId),
    resourceType,
    resourceId,
    action: "stop",
    expectedLifecycleRevision: safeRevision(record.expectedLifecycleRevision),
    status,
    computeStopped: invariant.stopped,
    providerStopped: invariant.stopped,
    retainedBackupBilling,
    infrastructureStatus: invariant.infrastructureStatus,
    acceptedAt: canonicalIsoTimestamp(record.acceptedAt),
    pollEndpoint: parsePollEndpoint(record.pollEndpoint, resourceId, receiptId),
  };
}

function parseHttpError(
  status: number,
  value: unknown,
  headers: Headers,
): BillingCancellationHttpError {
  let code = "billing_cancellation_failed";
  let message = "The billing cancellation request failed.";
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string" && record.code.trim()) {
      code = record.code;
    }
    if (typeof record.error === "string" && record.error.trim()) {
      message = record.error;
    } else if (typeof record.message === "string" && record.message.trim()) {
      message = record.message;
    }
  }
  return new BillingCancellationHttpError(
    status,
    code,
    message,
    status === 408 || status === 425 || status === 429 || status >= 500,
    parseRetryAfterMs(headers.get("Retry-After")),
  );
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1_000), 15 * 60_000);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, at - Date.now()), 15 * 60_000);
}

function assertRequestInput(input: RequestBillingCancellationInput): void {
  const resourceId = uuid(input.resourceId);
  if (
    input.endpoint !==
    cancellationRequestEndpoint(resourceId, input.resourceType)
  ) {
    throw new Error("Billing cancellation endpoint is invalid.");
  }
  safeRevision(input.expectedLifecycleRevision);
  if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    throw new Error("Billing cancellation idempotency key is invalid.");
  }
}

/** Admit or replay one exact cancellation command. */
export async function requestBillingCancellation(
  input: RequestBillingCancellationInput,
): Promise<BillingCancellationResult> {
  assertRequestInput(input);
  const response = await apiWithStatusAndHeaders<unknown>(input.endpoint, {
    method: "POST",
    headers: {
      "Idempotency-Key": input.idempotencyKey,
      [DURABLE_CANCEL_VERSION_HEADER]: "2",
    },
    json: {
      resourceType: input.resourceType,
      mode: "stop",
      expectedLifecycleRevision: input.expectedLifecycleRevision,
    },
    signal: input.signal,
  });
  const envelope = asRecord(response.data);
  if (!("receipt" in envelope)) {
    throw parseHttpError(
      response.status,
      response.data,
      response.headers ?? new Headers(),
    );
  }
  if (
    typeof envelope.disposition !== "string" ||
    !DISPOSITIONS.has(
      envelope.disposition as BillingCancellationResult["disposition"],
    )
  ) {
    return invalidResponse();
  }
  const receipt = parseReceipt(envelope.receipt);
  if (
    receipt.resourceId !== input.resourceId.toLowerCase() ||
    receipt.resourceType !== input.resourceType ||
    receipt.expectedLifecycleRevision !== input.expectedLifecycleRevision
  ) {
    return invalidResponse();
  }
  const expectedHttpStatus =
    receipt.status === "accepted"
      ? 202
      : receipt.status === "conflict"
        ? 409
        : receipt.status === "terminal_attention"
          ? 424
          : 200;
  const expectedSuccess = !["conflict", "terminal_attention"].includes(
    receipt.status,
  );
  if (
    response.status !== expectedHttpStatus ||
    envelope.success !== expectedSuccess
  ) {
    return invalidResponse();
  }
  return {
    disposition:
      envelope.disposition as BillingCancellationResult["disposition"],
    receipt,
  };
}

/** Read the durable, tenant-scoped business receipt exposed by the POST. */
export async function readBillingCancellationReceipt(
  pollEndpoint: string,
  expected: {
    resourceType: BillingCancellationResourceType;
    resourceId: string;
    expectedLifecycleRevision: number;
    receiptId: string;
  },
  signal?: AbortSignal,
): Promise<BillingCancellationReceipt> {
  const resourceId = uuid(expected.resourceId);
  const receiptId = uuid(expected.receiptId);
  safeRevision(expected.expectedLifecycleRevision);
  if (
    pollEndpoint !==
    `${cancellationEndpoint(resourceId)}?receiptId=${receiptId}`
  ) {
    throw new Error("Billing cancellation poll endpoint is invalid.");
  }
  const response = await apiWithStatusAndHeaders<unknown>(pollEndpoint, {
    headers: { [DURABLE_CANCEL_VERSION_HEADER]: "2" },
    signal,
  });
  if (response.status !== 200) {
    throw parseHttpError(
      response.status,
      response.data,
      response.headers ?? new Headers(),
    );
  }
  const envelope = asRecord(response.data);
  if (envelope.success !== true) return invalidResponse();
  const receipt = parseReceipt(envelope.receipt);
  if (
    receipt.resourceType !== expected.resourceType ||
    receipt.resourceId !== resourceId ||
    receipt.receiptId !== receiptId ||
    receipt.expectedLifecycleRevision !== expected.expectedLifecycleRevision ||
    receipt.pollEndpoint !== pollEndpoint
  ) {
    return invalidResponse();
  }
  return receipt;
}
