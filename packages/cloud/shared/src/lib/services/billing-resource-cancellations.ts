/**
 * Durable admission and replay contract for explicit billable-resource stops.
 * The command, every client-key alias, the stop intent, and the async job are
 * committed together before a daemon can observe any infrastructure effect.
 */

import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/client";
import {
  type BillingCancelCommandBundle,
  type BillingCancelLogicalIdentity,
  billingCancelCommandsRepository,
} from "../../db/repositories/billing-cancel-commands";
import type { BillingCancelResourceType } from "../../db/schemas/billing-cancel-commands";
import type { AppEnv } from "../../types/cloud-worker-env";
import { ApiError } from "../api/cloud-worker-errors";
import { AGENT_PRICING } from "../constants/agent-pricing";
import { logger } from "../utils/logger";
import { isValidUUID } from "../utils/validation";
import {
  enqueueContainerUserStopInTx,
  lockContainerStopTargetInTx,
} from "./container-stop-job-service";
import { lockAgentSuspendTargetInTx, provisioningJobService } from "./provisioning-jobs";

export type BillingCancellationDisposition = "accepted" | "same_key_replay" | "same_command";

export type BillingCancellationStatus =
  | "accepted"
  | "provider_confirmed"
  | "conflict"
  | "terminal_attention";

export interface BillingCancellationReceipt {
  receiptId: string;
  jobId: string;
  resourceType: BillingCancelResourceType;
  resourceId: string;
  action: "stop";
  expectedLifecycleRevision: number;
  status: BillingCancellationStatus;
  /** True only after the provider has confirmed that live compute is absent. */
  computeStopped: boolean;
  /** Provider-side stop acknowledgement; never inferred from job completion alone. */
  providerStopped: boolean;
  retainedBackupBilling: {
    status: "not_applicable" | "pending" | "none" | "billable";
    ratePerHour: number | null;
  };
  infrastructureStatus: "queued" | "provider_confirmed" | "superseded" | "terminal_attention";
  acceptedAt: string;
  pollEndpoint: string;
}

export interface BillingCancellationResult {
  disposition: BillingCancellationDisposition;
  receipt: BillingCancellationReceipt;
}

export interface RequestBillingCancellationOptions {
  organizationId: string;
  requestedByUserId: string;
  resourceType: BillingCancelResourceType;
  resourceId: string;
  expectedLifecycleRevision: number;
  idempotencyKey: string;
  triggerEnv?: AppEnv["Bindings"];
  /** Returns the steward_user_id bound to the freshly revalidated credential. */
  authorizeInfrastructureMutation: () => Promise<string | null | undefined>;
}

export const BILLING_CANCELLATION_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertInput(options: RequestBillingCancellationOptions): void {
  if (!isValidUUID(options.resourceId)) {
    throw new ApiError(400, "validation_error", "resourceId must be a UUID");
  }
  if (!BILLING_CANCELLATION_IDEMPOTENCY_KEY_PATTERN.test(options.idempotencyKey)) {
    throw new ApiError(
      400,
      "validation_error",
      "A valid Idempotency-Key header is required for billing cancellation",
    );
  }
  if (
    !Number.isSafeInteger(options.expectedLifecycleRevision) ||
    options.expectedLifecycleRevision < 0
  ) {
    throw new ApiError(
      400,
      "validation_error",
      "expectedLifecycleRevision must be a non-negative safe integer",
    );
  }
}

function requestContract(options: RequestBillingCancellationOptions): readonly unknown[] {
  return [
    "billing-cancel:v1",
    options.organizationId,
    options.resourceType,
    options.resourceId,
    "stop",
    options.expectedLifecycleRevision,
  ] as const;
}

function terminalReason(bundle: BillingCancelCommandBundle): string {
  const result = bundle.job.result ?? {};
  const reason = result.reason ?? result.skippedReason ?? result.error;
  return typeof reason === "string" ? reason.toLowerCase() : "";
}

function projectReceipt(bundle: BillingCancelCommandBundle): BillingCancellationReceipt {
  const { command, job } = bundle;
  const result = job.result ?? {};
  const intent =
    command.resource_type === "container" ? bundle.containerIntent : bundle.agentIntent;
  // A terminal durable intent is authoritative even when asynchronous job
  // settlement disagrees. While the intent is still non-terminal, however,
  // the job envelope must surface terminal failure or cancellation instead of
  // leaving the receipt indefinitely queued.
  const terminalIntentStatus =
    intent?.status === "provider_confirmed" ||
    intent?.status === "superseded" ||
    intent?.status === "terminal_attention"
      ? intent.status
      : null;
  // Provider acknowledgement is the authoritative infrastructure fact even
  // while the durable job retries or terminal settlement needs attention.
  // Status is an operational envelope; the write-once proof must never
  // regress the public receipt to queued, conflicted, or not stopped.
  const hasProviderProof = intent?.provider_confirmed_at != null;
  const providerConfirmed =
    hasProviderProof ||
    terminalIntentStatus === "provider_confirmed" ||
    (terminalIntentStatus === null &&
      job.status === "completed" &&
      (result.stopped === true || result.containerStopped === true));
  const superseded =
    terminalIntentStatus === "superseded" ||
    (terminalIntentStatus === null &&
      (job.status === "cancelled" ||
        terminalReason(bundle).includes("stale") ||
        terminalReason(bundle).includes("supersed") ||
        result.skipped === true));
  const terminalAttention =
    terminalIntentStatus === "terminal_attention" ||
    (terminalIntentStatus === null && job.status === "failed");
  const status: BillingCancellationStatus = providerConfirmed
    ? "provider_confirmed"
    : superseded
      ? "conflict"
      : terminalAttention
        ? "terminal_attention"
        : "accepted";
  const retainedBackupBilling: BillingCancellationReceipt["retainedBackupBilling"] =
    command.resource_type === "container"
      ? { status: "not_applicable", ratePerHour: null }
      : providerConfirmed
        ? bundle.agentIntent?.retained_backup_billing
          ? {
              status: "billable",
              ratePerHour: Number(
                bundle.agentIntent.retained_backup_rate_per_hour ?? AGENT_PRICING.IDLE_HOURLY_RATE,
              ),
            }
          : { status: "none", ratePerHour: null }
        : { status: "pending", ratePerHour: AGENT_PRICING.IDLE_HOURLY_RATE };
  return {
    receiptId: command.id,
    jobId: command.job_id,
    resourceType: command.resource_type,
    resourceId: command.resource_id,
    action: "stop",
    expectedLifecycleRevision: command.expected_lifecycle_revision,
    status,
    computeStopped: providerConfirmed,
    providerStopped: providerConfirmed,
    retainedBackupBilling,
    infrastructureStatus: providerConfirmed
      ? "provider_confirmed"
      : superseded
        ? "superseded"
        : terminalAttention
          ? "terminal_attention"
          : "queued",
    acceptedAt: command.created_at.toISOString(),
    pollEndpoint: `/api/v1/jobs/${command.job_id}`,
  };
}

function idempotencyConflict(details?: Record<string, unknown>): ApiError {
  return new ApiError(
    409,
    "billing_state_conflict",
    "Idempotency-Key was already used for a different billing cancellation request",
    details,
  );
}

function staleRevision(
  options: RequestBillingCancellationOptions,
  currentLifecycleRevision: number | null,
): ApiError {
  return new ApiError(
    currentLifecycleRevision === null ? 404 : 409,
    currentLifecycleRevision === null ? "resource_not_found" : "billing_state_conflict",
    currentLifecycleRevision === null
      ? "Billable resource not found"
      : "Billable resource lifecycle changed; refresh before retrying",
    {
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      expectedLifecycleRevision: options.expectedLifecycleRevision,
      currentLifecycleRevision,
    },
  );
}

async function enqueueStopInTransaction(
  tx: DbTransaction,
  options: RequestBillingCancellationOptions,
): Promise<{ jobId: string }> {
  if (options.resourceType === "container") {
    const result = await enqueueContainerUserStopInTx(tx, {
      containerId: options.resourceId,
      organizationId: options.organizationId,
      userId: options.requestedByUserId,
      expectedLifecycleRevision: options.expectedLifecycleRevision,
    });
    if (!result.requested) {
      throw staleRevision(options, result.currentLifecycleRevision);
    }
    return { jobId: result.jobId };
  }

  const result = await provisioningJobService.enqueueAgentSuspendOnceInTransaction(tx, {
    agentId: options.resourceId,
    organizationId: options.organizationId,
    userId: options.requestedByUserId,
    authorization: "user_request",
    expectedLifecycleRevision: options.expectedLifecycleRevision,
  });
  return { jobId: result.job.id };
}

/**
 * Establish the global cancellation lock order without creating any durable
 * effect: target/lifecycle first, then the caller acquires organization and
 * user authority. Exact command replays skip this lock because they enqueue no
 * target mutation and must remain valid after the accepted lifecycle advances.
 */
export async function lockBillingCancellationTargetInTx(
  tx: DbTransaction,
  options: RequestBillingCancellationOptions,
): Promise<void> {
  if (options.resourceType === "container") {
    await lockContainerStopTargetInTx(tx, {
      containerId: options.resourceId,
      organizationId: options.organizationId,
    });
    return;
  }
  await lockAgentSuspendTargetInTx(tx, {
    agentId: options.resourceId,
    organizationId: options.organizationId,
  });
}

export interface BillingResourceCancellationsDependencies {
  transact<T>(callback: (tx: DbTransaction) => Promise<T>): Promise<T>;
  lockTarget(tx: DbTransaction, options: RequestBillingCancellationOptions): Promise<void>;
  enqueueStop(
    tx: DbTransaction,
    options: RequestBillingCancellationOptions,
  ): Promise<{ jobId: string }>;
  triggerImmediate(env: AppEnv["Bindings"]): Promise<unknown>;
}

const defaultDependencies: BillingResourceCancellationsDependencies = {
  transact: (callback) => dbWrite.transaction(callback),
  lockTarget: lockBillingCancellationTargetInTx,
  enqueueStop: enqueueStopInTransaction,
  triggerImmediate: (env) => provisioningJobService.triggerImmediate(env),
};

export class BillingResourceCancellationsService {
  constructor(
    private readonly dependencies: BillingResourceCancellationsDependencies = defaultDependencies,
  ) {}

  async request(options: RequestBillingCancellationOptions): Promise<BillingCancellationResult> {
    assertInput(options);
    const normalizedOptions = { ...options, resourceId: options.resourceId.toLowerCase() };
    const keyHash = await sha256Hex(normalizedOptions.idempotencyKey);
    const requestDigest = await sha256Hex(JSON.stringify(requestContract(normalizedOptions)));
    const identity: BillingCancelLogicalIdentity = {
      organizationId: normalizedOptions.organizationId,
      resourceType: normalizedOptions.resourceType,
      resourceId: normalizedOptions.resourceId,
      expectedLifecycleRevision: normalizedOptions.expectedLifecycleRevision,
      action: "stop",
    };

    // Production callers revalidate the request credential with a primary
    // database read. Keep that read outside the transaction because Worker
    // requests use a single-connection pool; re-entering dbWrite while the
    // transaction owns its only connection would wait until checkout timeout.
    // The transaction still fences the returned identity against the current
    // organization/user rows before it creates any durable effect.
    const expectedStewardUserId = await normalizedOptions.authorizeInfrastructureMutation();
    if (!expectedStewardUserId) {
      throw new ApiError(
        403,
        "access_denied",
        "Billing cancellation credential identity changed; refresh and retry",
      );
    }

    const result = await this.dependencies.transact(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-cancel-key:${normalizedOptions.organizationId}:${keyHash}`}, 0))`,
      );
      const keyReplay = await billingCancelCommandsRepository.findByKeyHash(
        tx,
        normalizedOptions.organizationId,
        keyHash,
      );
      if (keyReplay) {
        if (keyReplay.key.request_digest !== requestDigest) {
          throw idempotencyConflict({ receiptId: keyReplay.command.id });
        }
        return {
          disposition: "same_key_replay" as const,
          bundle: keyReplay,
          shouldNudge: false,
        };
      }

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-cancel:${normalizedOptions.organizationId}:${normalizedOptions.resourceType}:${normalizedOptions.resourceId}:${normalizedOptions.expectedLifecycleRevision}:stop`}, 0))`,
      );
      const logicalReplay = await billingCancelCommandsRepository.findLogical(tx, identity);

      // New commands join the same target/lifecycle serialization boundary as
      // billing stops before they take organization/user authority. Otherwise
      // billing can hold the target while waiting for the organization as an
      // explicit cancellation holds the organization while waiting for the
      // target, producing PostgreSQL 40P01 and a generic route failure.
      if (!logicalReplay) {
        await this.dependencies.lockTarget(tx, normalizedOptions);
      }

      // Acquire primary database authority in the durable transaction. The
      // organization and user FOR SHARE locks close the gap where a concurrent
      // role or eligibility revocation could commit between the fresh
      // credential check above and replay binding/job admission.
      const hasCurrentAuthority = await billingCancelCommandsRepository.lockBillingManagerAuthority(
        tx,
        normalizedOptions.organizationId,
        normalizedOptions.requestedByUserId,
        expectedStewardUserId,
      );
      if (!hasCurrentAuthority) {
        throw new ApiError(
          403,
          "access_denied",
          "Billing cancellation authority changed; refresh and retry",
        );
      }

      if (logicalReplay) {
        const bound = await billingCancelCommandsRepository.bindKey(tx, {
          organizationId: normalizedOptions.organizationId,
          keyHash,
          requestDigest,
          commandId: logicalReplay.command.id,
          requestedByUserId: normalizedOptions.requestedByUserId,
        });
        if (
          bound.key.request_digest !== requestDigest ||
          bound.key.command_id !== logicalReplay.command.id
        ) {
          throw idempotencyConflict({ receiptId: bound.key.command_id });
        }
        return {
          disposition: "same_command" as const,
          bundle: logicalReplay,
          shouldNudge: logicalReplay.job.status === "pending",
        };
      }

      const enqueued = await this.dependencies.enqueueStop(tx, normalizedOptions);
      const command = await billingCancelCommandsRepository.createCommand(tx, {
        ...identity,
        requestedByUserId: normalizedOptions.requestedByUserId,
        jobId: enqueued.jobId,
      });
      if (!command.inserted && command.bundle.job.id !== enqueued.jobId) {
        throw new ApiError(
          409,
          "billing_state_conflict",
          "A different stop job already owns this resource lifecycle",
          { receiptId: command.bundle.command.id, jobId: command.bundle.command.job_id },
        );
      }
      const bound = await billingCancelCommandsRepository.bindKey(tx, {
        organizationId: normalizedOptions.organizationId,
        keyHash,
        requestDigest,
        commandId: command.bundle.command.id,
        requestedByUserId: normalizedOptions.requestedByUserId,
      });
      if (
        bound.key.request_digest !== requestDigest ||
        bound.key.command_id !== command.bundle.command.id
      ) {
        throw idempotencyConflict({ receiptId: bound.key.command_id });
      }
      return {
        disposition: "accepted" as const,
        bundle: command.bundle,
        shouldNudge: true,
      };
    });

    if (result.shouldNudge && normalizedOptions.triggerEnv) {
      void this.dependencies.triggerImmediate(normalizedOptions.triggerEnv).catch((error) => {
        // error-policy:J5 The provisioning-jobs durable poller observes the
        // committed job and retries it.
        logger.warn(
          "[billing-cancel] Immediate job trigger failed; durable polling remains active",
          {
            receiptId: result.bundle.command.id,
            jobId: result.bundle.command.job_id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    }
    return { disposition: result.disposition, receipt: projectReceipt(result.bundle) };
  }
}

export const billingResourceCancellationsService = new BillingResourceCancellationsService();
