/**
 * `pendingApprovals` provider — surfaces the owner's PENDING approval-queue
 * rows (gated sends, signatures, bookings, calls) so the router and planner
 * can see that a queued request is awaiting a decision and route the owner's
 * approve/hold/reject through RESOLVE_REQUEST instead of a plain reply.
 *
 * Without this live view the model has no in-prompt signal that a queue row
 * exists: an owner saying "don't send it, reject that for now" reads like
 * conversation, the reply confirms a hold, and the approval stays `pending`
 * forever (#14630). The provider is `alwaysInResponseState` because Stage-1
 * routing names candidate actions before context routing has run — the queue
 * must be visible on the turn where the decision arrives, whatever contexts
 * that turn classifies into. The happy-path render is empty and the read is
 * one bounded SQL, per the always-on provider contract.
 */
import { hasOwnerAccess } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import type { ApprovalRequest } from "../lifeops/approval-queue.types.js";

const EMPTY: ProviderResult = {
  text: "",
  values: { pendingApprovalCount: 0 },
  data: { pendingApprovals: [] },
};

const APPROVALS_MAX_DISPLAYED = 5;
const APPROVALS_QUERY_LIMIT = 20;

// Renders id + action + reason but never the queued payload: the reason is
// authored for owner-facing display, while payloads carry full message/email
// bodies that would bloat and leak into every prompt.
function formatApprovalLine(request: ApprovalRequest): string {
  return `- id=${request.id} action=${request.action} channel=${request.channel} — ${request.reason} (expires ${request.expiresAt.toISOString()})`;
}

/**
 * Planner-text rendering of the pending queue. Exported so integration tests
 * and scenarios can assert the exact routing contract the model receives.
 */
export function renderPendingApprovalsText(
  requests: ReadonlyArray<ApprovalRequest>,
): string {
  if (requests.length === 0) return "";
  const lines = requests
    .slice(0, APPROVALS_MAX_DISPLAYED)
    .map((request) => formatApprovalLine(request));
  if (requests.length > APPROVALS_MAX_DISPLAYED) {
    lines.push(`(+${requests.length - APPROVALS_MAX_DISPLAYED} more)`);
  }
  return [
    "# Pending Approvals (queued actions awaiting the owner's decision)",
    ...lines,
    'When the owner decides on one of these, resolve it with RESOLVE_REQUEST: approve dispatches the queued action; reject leaves it permanently un-dispatched. A hold — "don\'t send it", "not yet", "hold off until I confirm" — is a rejection: nothing is lost, a fresh request can be queued later. Never leave a decided request pending.',
  ].join("\n");
}

export const pendingApprovalsProvider: Provider = {
  name: "pendingApprovals",
  description:
    "Surfaces the owner's pending approval-queue requests (gated sends, signatures, bookings, calls) " +
    "so approve/hold/reject decisions route to RESOLVE_REQUEST instead of a plain reply.",
  descriptionCompressed:
    "Pending approval-queue rows — owner decisions route to RESOLVE_REQUEST.",
  dynamic: true,
  // Stage-1 grounding (see header): bypass context routing so the queue is
  // visible on the very turn the owner's decision arrives.
  alwaysInResponseState: true,
  // Just ahead of the lifeops capability provider (12) so the live queue
  // state precedes the routing prose.
  position: 11,
  cacheScope: "turn",
  contexts: [
    "messaging",
    "email",
    "calendar",
    "tasks",
    "payments",
    "automation",
    "general",
  ],
  contextGate: {
    anyOf: [
      "messaging",
      "email",
      "calendar",
      "tasks",
      "payments",
      "automation",
      "general",
    ],
  },
  roleGate: { minRole: "OWNER" },

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasOwnerAccess(runtime, message))) {
      return EMPTY;
    }
    // Approvals are enqueued with subjectUserId = the requesting owner's
    // entityId (see actions/owner-surfaces.ts), and RESOLVE_REQUEST lists by
    // the same key — the provider mirrors that scoping exactly so it shows
    // precisely the rows the action can resolve.
    const subjectUserId =
      typeof message.entityId === "string" ? message.entityId : "";
    if (!subjectUserId) return EMPTY;

    let pending: ReadonlyArray<ApprovalRequest>;
    try {
      const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
      pending = await queue.list({
        subjectUserId,
        state: "pending",
        action: null,
        limit: APPROVALS_QUERY_LIMIT,
      });
    } catch (error) {
      // error-policy:J4 explicit user-facing degrade — a queue-read failure
      // omits the approvals block (empty, never a fabricated "no approvals
      // pending"); reportError surfaces it in RECENT_ERRORS so a broken queue
      // cannot silently reintroduce the stuck-pending failure this provider
      // exists to prevent.
      runtime.reportError?.("pending-approvals.provider", error);
      return EMPTY;
    }
    if (pending.length === 0) return EMPTY;

    return {
      text: renderPendingApprovalsText(pending),
      values: {
        pendingApprovalCount: pending.length,
        pendingApprovalIds: pending.map((request) => request.id),
      },
      data: { pendingApprovals: pending },
    };
  },
};

export default pendingApprovalsProvider;
