/**
 * WS5 — glue between {@link planJob} and the WS6 approval queue.
 *
 * Every background job calls {@link planJob} and passes the result here.
 * Sensitive actions (`requiresApproval === true` with a usable payload)
 * are enqueued via the queue exposed by the runtime as service
 * "APPROVAL_QUEUE". Non-sensitive actions and noops are recorded for
 * observability and returned.
 *
 * No side-effects other than enqueue + logger. No try/catch swallow: a
 * missing queue is a typed error that surfaces to the caller.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  ApprovalEnqueueInput,
  ApprovalQueue,
  ApprovalRequest,
} from "./approval-queue.types.js";
import type {
  BackgroundJobContext,
  TypedJobPlan,
} from "./background-planner.js";

export const APPROVAL_QUEUE_SERVICE_NAME = "APPROVAL_QUEUE" as const;

/** Default expiry window for queued background-job approvals: 24 hours. */
export const DEFAULT_BACKGROUND_APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Raised when a sensitive plan cannot be enqueued because the WS6 queue is
 * not registered on the runtime. We surface this loudly so the bug cannot
 * hide as a silent skip.
 */
export class ApprovalQueueUnavailableError extends Error {
  public readonly jobKind: string;
  constructor(jobKind: string) {
    super(
      `[BackgroundPlanner:${jobKind}] approval queue service '${APPROVAL_QUEUE_SERVICE_NAME}' is not registered`,
    );
    this.name = "ApprovalQueueUnavailableError";
    this.jobKind = jobKind;
  }
}

function getApprovalQueue(runtime: IAgentRuntime): ApprovalQueue | null {
  const service = runtime.getService(APPROVAL_QUEUE_SERVICE_NAME);
  if (!service) return null;
  if (typeof service !== "object") return null;
  const candidate = service as Partial<ApprovalQueue>;
  return typeof candidate.enqueue === "function"
    ? (candidate as ApprovalQueue)
    : null;
}

/**
 * Result returned from {@link enqueueIfSensitive} so callers and tests can
 * introspect what the planner decided for this tick.
 */
export interface PlannerDispatchResult {
  readonly jobKind: string;
  readonly plan: TypedJobPlan;
  /** Non-null when a request was enqueued. */
  readonly approvalRequest: ApprovalRequest | null;
  /** True when the plan was a noop or purely internal (no enqueue). */
  readonly skipped: boolean;
  /** When skipped=true, the reason. */
  readonly skipReason: string | null;
}

/**
 * If the plan is sensitive AND has a usable payload, enqueue it in the WS6
 * approval queue. Otherwise, return a skipped result. Always records the
 * decision to the runtime-scoped observability log via
 * {@link recordPlannerDispatch} so the contract test can introspect.
 */
export async function enqueueIfSensitive(
  runtime: IAgentRuntime,
  jobContext: BackgroundJobContext,
  plan: TypedJobPlan,
  now: Date = new Date(),
): Promise<PlannerDispatchResult> {
  if (plan.action === null) {
    const result: PlannerDispatchResult = {
      jobKind: jobContext.jobKind,
      plan,
      approvalRequest: null,
      skipped: true,
      skipReason: "planner returned noop",
    };
    recordPlannerDispatch(runtime, result);
    return result;
  }

  if (!plan.requiresApproval) {
    const result: PlannerDispatchResult = {
      jobKind: jobContext.jobKind,
      plan,
      approvalRequest: null,
      skipped: true,
      skipReason: "planner marked requiresApproval=false",
    };
    recordPlannerDispatch(runtime, result);
    return result;
  }

  if (plan.payload === null) {
    const result: PlannerDispatchResult = {
      jobKind: jobContext.jobKind,
      plan,
      approvalRequest: null,
      skipped: true,
      skipReason: "planner produced sensitive action without usable payload",
    };
    recordPlannerDispatch(runtime, result);
    logger.warn(
      `[BackgroundPlanner:${jobContext.jobKind}] sensitive action ${plan.action} skipped — no payload`,
    );
    return result;
  }

  const queue = getApprovalQueue(runtime);
  if (!queue) {
    throw new ApprovalQueueUnavailableError(jobContext.jobKind);
  }

  const input: ApprovalEnqueueInput = {
    requestedBy: `background-job:${jobContext.jobKind}`,
    subjectUserId: jobContext.subjectUserId,
    action: plan.action,
    payload: plan.payload,
    channel: plan.channel,
    reason: plan.reason,
    expiresAt: new Date(now.getTime() + DEFAULT_BACKGROUND_APPROVAL_EXPIRY_MS),
  };

  const approvalRequest = await queue.enqueue(input);
  const result: PlannerDispatchResult = {
    jobKind: jobContext.jobKind,
    plan,
    approvalRequest,
    skipped: false,
    skipReason: null,
  };
  recordPlannerDispatch(runtime, result);
  logger.info(
    `[BackgroundPlanner:${jobContext.jobKind}] enqueued approval ${approvalRequest.id} (${plan.action} on ${plan.channel})`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Test observability
// ---------------------------------------------------------------------------

const DISPATCH_LOG_KEY = Symbol.for("eliza.lifeops.background-planner.log");
const DISPATCH_LOG_MAX_ENTRIES = 200;

interface DispatchLogHolder extends IAgentRuntime {
  [DISPATCH_LOG_KEY]?: PlannerDispatchResult[];
}

/**
 * Record a planner dispatch decision on the runtime object so the contract
 * test can inspect every invocation without racing against the real
 * approval queue or LLM. Bounded to DISPATCH_LOG_MAX_ENTRIES to prevent the
 * log from growing unbounded on long-lived runtimes.
 */
export function recordPlannerDispatch(
  runtime: IAgentRuntime,
  result: PlannerDispatchResult,
): void {
  const holder = runtime as DispatchLogHolder;
  const log = holder[DISPATCH_LOG_KEY] ?? [];
  log.push(result);
  if (log.length > DISPATCH_LOG_MAX_ENTRIES) {
    log.splice(0, log.length - DISPATCH_LOG_MAX_ENTRIES);
  }
  holder[DISPATCH_LOG_KEY] = log;
}

/** Test-only: read the in-memory dispatch log for a runtime. */
export function readPlannerDispatchLog(
  runtime: IAgentRuntime,
): ReadonlyArray<PlannerDispatchResult> {
  const holder = runtime as DispatchLogHolder;
  return holder[DISPATCH_LOG_KEY] ?? [];
}

/** Test-only: clear the dispatch log between runs. */
export function resetPlannerDispatchLog(runtime: IAgentRuntime): void {
  const holder = runtime as DispatchLogHolder;
  holder[DISPATCH_LOG_KEY] = [];
}
