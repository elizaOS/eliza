/**
 * Per-step progress and approval-relay plumbing for computer-use actions. Wraps a
 * handler so each dispatched sub-action emits structured progress content and
 * pending-approval snapshots to the message callback.
 */
import {
  type Content,
  type HandlerCallback,
  logger,
  type Memory,
} from "@elizaos/core";
import type { ApprovalSnapshot, PendingApproval } from "../types.js";

export const ACTION_PROGRESS_SOURCE = "action_progress";
export const COMPUTER_USE_APPROVAL_SOURCE = "computeruse_approval";

export interface StepProgressInput {
  actionName: string;
  step: number;
  kind: string;
  rationale?: string;
  success?: boolean;
  error?: string;
  source?: string;
}

export interface ApprovalRelayService {
  getApprovalSnapshot(): ApprovalSnapshot;
  subscribeApprovals(
    listener: (snapshot: ApprovalSnapshot) => void,
  ): () => void;
}

export interface ApprovalRelayOptions {
  ownerId?: string;
}

export function isStreamProgressEnabled(value: unknown): value is true {
  return value === true;
}

export function formatStepProgressText(
  step: number,
  kind: string,
  rationale?: string,
): string {
  const trimmed = rationale?.trim();
  return `Step ${step}: ${kind} — ${trimmed || "dispatched"}`;
}

export function buildStepProgressContent(input: StepProgressInput): Content {
  const rationale = input.rationale?.trim() || "dispatched";
  return {
    text: formatStepProgressText(input.step, input.kind, rationale),
    source: ACTION_PROGRESS_SOURCE,
    merge: "replace",
    metadata: {
      transient: true,
      compactProgress: true,
      progress: {
        source: input.source ?? "computeruse",
        actionName: input.actionName,
        step: input.step,
        kind: input.kind,
        rationale,
        success: input.success,
        error: input.error,
      },
    },
  };
}

function approvalCallbackValue(
  approvalId: string,
  decision: "approve" | "deny",
  ownerId?: string,
): string {
  return ownerId
    ? `cua:${approvalId}:${decision}:u${ownerId}`
    : `cua:${approvalId}:${decision}`;
}

export function buildApprovalPromptContent(
  approval: PendingApproval,
  options: ApprovalRelayOptions = {},
): Content {
  return {
    text: [
      `Computer-use approval requested for \`${approval.command}\`.`,
      `[CHOICE:computeruse-approval id=${approval.id}]`,
      `${approvalCallbackValue(approval.id, "approve", options.ownerId)}=Approve`,
      `${approvalCallbackValue(approval.id, "deny", options.ownerId)}=Deny`,
      "[/CHOICE]",
    ].join("\n"),
    source: COMPUTER_USE_APPROVAL_SOURCE,
    metadata: {
      transient: true,
      computeruse: {
        approvalId: approval.id,
        command: approval.command,
        requestedAt: approval.requestedAt,
        ownerId: options.ownerId,
      },
    },
  };
}

export async function withApprovalRelay<T>(
  service: ApprovalRelayService,
  callback: HandlerCallback | undefined,
  run: () => Promise<T>,
  options: ApprovalRelayOptions = {},
): Promise<T> {
  if (!callback) {
    return run();
  }

  const seen = new Set<string>();
  for (const approval of service.getApprovalSnapshot().pendingApprovals) {
    seen.add(approval.id);
  }

  const deliveries: Array<Promise<Memory[]>> = [];
  const unsubscribe = service.subscribeApprovals((snapshot) => {
    for (const approval of snapshot.pendingApprovals) {
      if (seen.has(approval.id)) continue;
      seen.add(approval.id);
      deliveries.push(
        callback(
          buildApprovalPromptContent(approval, options),
          "COMPUTER_USE_APPROVAL",
        ).catch((error) => {
          // error-policy:J5 the rejection is observed HERE (warn with the
          // approval id); a failed relay must not abort the approval flow —
          // the approval stays queued and resolvable via the routes/UI.
          logger.warn(
            {
              src: "plugin:computeruse",
              approvalId: approval.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to relay computer-use approval request",
          );
          return [];
        }),
      );
    }
  });

  try {
    return await run();
  } finally {
    unsubscribe();
    await Promise.allSettled(deliveries);
  }
}
