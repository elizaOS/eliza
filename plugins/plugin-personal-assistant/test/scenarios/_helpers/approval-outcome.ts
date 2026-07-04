// Provides shared scenario helpers for LifeOps approval and owner-outcome checks.
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";

/**
 * Shared OUTCOME predicates for approval-gated executive-assistant scenarios.
 *
 * These assert against the live approval queue, not against reply wording:
 * the seed turn enqueues a real `approval_requests` row through
 * `PERSONAL_ASSISTANT(action=sign_document)` (`enqueueDocumentSignatureApproval`
 * in `src/actions/owner-surfaces.ts`, which calls `PgApprovalQueue.enqueue`),
 * and the owner's decision runs through the live `RESOLVE_REQUEST` action whose
 * `ActionResult.data.state` is the value returned by the queue's SQL UPDATE
 * (`transitionWithResolution` in `src/lifeops/approval-queue.ts`). The runner
 * captures both on `ctx.actionsCalled` (`packages/scenario-runner/src/interceptor.ts`).
 *
 * We deliberately do NOT use the `approvalRequestExists` /
 * `approvalStateTransition` final-check types for these flows: the runner's
 * approval capture only fires for `runtime.createTask`-based approvals and
 * nothing emits a `subject: "approval"` transition, so those checks would
 * skip/fail regardless of the real queue state (see the rationale in
 * `approval-queue-resolve-outcome.scenario.ts`).
 */

type CapturedActionLite = ScenarioContext["actionsCalled"][number];

const RESOLVED_STATES_APPROVE = new Set(["approved", "executing", "done"]);
const SIDE_EFFECT_STATES = new Set(["executing", "done"]);

/** Channels on which an outbound send would be a real-world side effect. */
const EXTERNAL_SEND_CHANNELS = new Set([
  "gmail",
  "email",
  "telegram",
  "discord",
  "signal",
  "slack",
  "sms",
  "imessage",
  "whatsapp",
  "x_dm",
  "phone_call",
]);

function resultData(
  action: CapturedActionLite,
): Record<string, unknown> | null {
  const data = action.result?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return null;
}

function resolveRequestCalls(
  ctx: ScenarioContext,
): ReadonlyArray<CapturedActionLite> {
  return ctx.actionsCalled.filter((a) => a.actionName === "RESOLVE_REQUEST");
}

function stateOf(action: CapturedActionLite): string {
  const state = resultData(action)?.state;
  return typeof state === "string" ? state : "";
}

function calledActions(ctx: ScenarioContext): string {
  return ctx.actionsCalled.map((a) => a.actionName).join(",") || "(none)";
}

/**
 * OUTCOME: the seed enqueued a real PENDING approval — a sign_document request
 * id came back off the live queue before any decision was made. `documentName`
 * scopes the check to the specific seeded request so a stray approval from
 * another turn cannot satisfy it.
 */
export function expectPendingApprovalSeeded(documentName: string) {
  return (ctx: ScenarioContext): string | undefined => {
    const seed = ctx.actionsCalled.find((a) => {
      if (a.actionName !== "PERSONAL_ASSISTANT") return false;
      const data = resultData(a);
      if (data?.action !== "sign_document") return false;
      const text = typeof a.result?.text === "string" ? a.result.text : "";
      return text.includes(documentName);
    });
    if (!seed) {
      return `seed PERSONAL_ASSISTANT(sign_document) for "${documentName}" was never captured. Actions: ${calledActions(ctx)}`;
    }
    if (seed.result?.success !== true) {
      return `seed sign_document for "${documentName}" did not return success=true (no approval enqueued)`;
    }
    const id = resultData(seed)?.approvalRequestId;
    if (typeof id !== "string" || id.length === 0) {
      return `seed sign_document for "${documentName}" returned no approvalRequestId — nothing was enqueued`;
    }
    return undefined;
  };
}

/**
 * OUTCOME: the owner's APPROVE decision moved the approval row out of
 * "pending" into approved/executing/done (the live queue's resolved states)
 * with the gated executor reporting success.
 */
export function expectApprovalResolvedApproved() {
  return (ctx: ScenarioContext): string | undefined => {
    const calls = resolveRequestCalls(ctx);
    if (calls.length === 0) {
      return `no RESOLVE_REQUEST call captured. Actions: ${calledActions(ctx)}`;
    }
    const resolved = calls.find(
      (c) =>
        c.result?.success === true && RESOLVED_STATES_APPROVE.has(stateOf(c)),
    );
    if (!resolved) {
      const seen = calls
        .map(
          (c) => `${stateOf(c) || "?"}(success=${String(c.result?.success)})`,
        )
        .join(", ");
      return `expected an approved RESOLVE_REQUEST whose result.data.state is one of approved/executing/done with success=true; saw [${seen}]`;
    }
    return undefined;
  };
}

/**
 * OUTCOME: the owner's REJECT/HOLD decision left the approval row in
 * "rejected" and the gated side effect never advanced to executing/done.
 */
export function expectApprovalRejectedNoSideEffect() {
  return (ctx: ScenarioContext): string | undefined => {
    const calls = resolveRequestCalls(ctx);
    if (calls.length === 0) {
      return `no RESOLVE_REQUEST call captured for the reject path. Actions: ${calledActions(ctx)}`;
    }
    const rejected = calls.find(
      (c) => c.result?.success === true && stateOf(c) === "rejected",
    );
    if (!rejected) {
      const seen = calls
        .map(
          (c) => `${stateOf(c) || "?"}(success=${String(c.result?.success)})`,
        )
        .join(", ");
      return `expected a RESOLVE_REQUEST whose result.data.state is "rejected" with success=true; saw [${seen}]`;
    }
    const sideEffect = calls.find((c) => SIDE_EFFECT_STATES.has(stateOf(c)));
    if (sideEffect) {
      return `reject path still produced a gated side effect: a RESOLVE_REQUEST reached state "${stateOf(sideEffect)}"`;
    }
    return undefined;
  };
}

/**
 * NEGATIVE OUTCOME: nothing was actually sent to a counterparty — no
 * connector dispatch with delivered=true landed on an external send channel
 * (drafting/queueing on dashboard-type surfaces is allowed). Used to prove
 * the approval gate held while drafts were being staged.
 */
export function expectNoExternalSendDispatch() {
  return (ctx: ScenarioContext): string | undefined => {
    const offending = (ctx.connectorDispatches ?? []).filter(
      (dispatch) =>
        dispatch.delivered === true &&
        EXTERNAL_SEND_CHANNELS.has(dispatch.channel.toLowerCase()),
    );
    if (offending.length > 0) {
      return `expected no delivered external send, saw ${offending.length}: [${offending
        .map((d) => d.channel)
        .join(", ")}]`;
    }
    return undefined;
  };
}
