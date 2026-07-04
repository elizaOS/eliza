/**
 * Live-model approval-queue resolution (#9970): seeds a real PENDING row in
 * `approval_requests` (PERSONAL_ASSISTANT sign_document -> live
 * `PgApprovalQueue.enqueue`), then drives the owner's approve/reject through the
 * live RESOLVE_REQUEST action and asserts the outcome read straight off the real
 * queue — approve advances the row past "pending" and runs the gated executor;
 * reject leaves it "rejected" with no gated side effect and no send/sign
 * confirmation.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type CapturedActionLite = ScenarioContext["actionsCalled"][number];

const RESOLVED_STATES_APPROVE = new Set(["approved", "executing", "done"]);
const SIDE_EFFECT_STATES = new Set(["executing", "done"]);

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
  const data = resultData(action);
  const state = data?.state;
  return typeof state === "string" ? state : "";
}

/**
 * OUTCOME: the seed enqueued a real PENDING approval — a sign_document
 * request id came back off the live queue before any decision was made.
 */
function expectPendingApprovalSeeded(ctx: ScenarioContext): string | undefined {
  const seed = ctx.actionsCalled.find(
    (a) =>
      a.actionName === "PERSONAL_ASSISTANT" &&
      resultData(a)?.action === "sign_document",
  );
  if (!seed) {
    return "seed PERSONAL_ASSISTANT(sign_document) was never captured";
  }
  if (seed.result?.success !== true) {
    return "seed sign_document did not return success=true (no approval enqueued)";
  }
  const id = resultData(seed)?.approvalRequestId;
  if (typeof id !== "string" || id.length === 0) {
    return "seed sign_document returned no approvalRequestId — nothing was enqueued";
  }
  return undefined;
}

/**
 * OUTCOME: the owner's APPROVE decision moved the approval row out of
 * "pending" into approved/executing/done (the live queue's resolved states)
 * and the gated executor ran (success=true). This is the pending->approved/done
 * transition + the gated side effect actually occurring.
 */
function expectApproveResolvedAndExecuted(
  ctx: ScenarioContext,
): string | undefined {
  const calls = resolveRequestCalls(ctx);
  if (calls.length === 0) {
    return `no RESOLVE_REQUEST call captured. Actions: ${
      ctx.actionsCalled.map((a) => a.actionName).join(",") || "(none)"
    }`;
  }
  const resolved = calls.find(
    (c) =>
      c.result?.success === true && RESOLVED_STATES_APPROVE.has(stateOf(c)),
  );
  if (!resolved) {
    const seen = calls
      .map((c) => `${stateOf(c) || "?"}(success=${String(c.result?.success)})`)
      .join(", ");
    return `expected an approved RESOLVE_REQUEST whose result.data.state is one of approved/executing/done with success=true; saw [${seen}]`;
  }
  return undefined;
}

/**
 * OUTCOME: the owner's REJECT decision left the approval row in "rejected"
 * and the gated side effect never advanced to executing/done — i.e. no
 * sign/send was dispatched on the rejected request.
 */
function expectRejectNoSideEffect(ctx: ScenarioContext): string | undefined {
  const calls = resolveRequestCalls(ctx);
  if (calls.length === 0) {
    return `no RESOLVE_REQUEST call captured for the reject path. Actions: ${
      ctx.actionsCalled.map((a) => a.actionName).join(",") || "(none)"
    }`;
  }
  const rejected = calls.find(
    (c) => c.result?.success === true && stateOf(c) === "rejected",
  );
  if (!rejected) {
    const seen = calls
      .map((c) => `${stateOf(c) || "?"}(success=${String(c.result?.success)})`)
      .join(", ");
    return `expected a RESOLVE_REQUEST whose result.data.state is "rejected" with success=true; saw [${seen}]`;
  }
  const sideEffect = calls.find((c) => SIDE_EFFECT_STATES.has(stateOf(c)));
  if (sideEffect) {
    return `reject path still produced a gated side effect: a RESOLVE_REQUEST reached state "${stateOf(sideEffect)}"`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "approval-queue-resolve-outcome",
  title:
    "Approval queue resolution: pending -> approved executes, reject is a no-op",
  domain: "lifeops.approvals",
  tags: ["lifeops", "executive-assistant", "approval", "outcome"],
  description:
    "Two paths over the live approval_requests queue. APPROVE path: a pending sign_document approval is seeded, the owner approves, and the row transitions pending -> approved/executing/done with the gated executor firing. REJECT companion path: a second pending approval is seeded, the owner rejects, the row lands in 'rejected', and no sign/send side effect ever runs.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Approval Queue Resolution (owner)",
    },
  ],
  turns: [
    // --- APPROVE PATH -------------------------------------------------------
    {
      // Deterministic seed: enqueue a real PENDING approval row directly through
      // the PERSONAL_ASSISTANT(sign_document) handler, which calls the live
      // PgApprovalQueue.enqueue. Bypassing LLM routing here keeps the seed
      // reliable; the capability under test is the *resolution*, not the seed.
      kind: "action",
      name: "seed-pending-sign-approval",
      room: "main",
      actionName: "PERSONAL_ASSISTANT",
      text: "Start the NDA signing flow, but get my approval before anything is sent.",
      options: {
        action: "sign_document",
        documentName: "Acme NDA",
        reason: "Counsel needs the Acme NDA countersigned before Friday.",
      },
      assertResponse(text: string) {
        if (!/approval|approve/i.test(text)) {
          return "seed reply must say the signing flow is gated on approval";
        }
      },
    },
    {
      // Live-LLM resolution: the owner approves. RESOLVE_REQUEST(approve) flips
      // the live row pending -> approved (executeApprovedRequest runs).
      kind: "message",
      name: "owner-approves",
      room: "main",
      text: "Yes, go ahead and approve the NDA signing request.",
      responseIncludesAny: ["approved", "approve", "NDA", "signing", "done"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "After the owner explicitly approves, the reply must confirm the pending approval was APPROVED and the signing flow is proceeding. A reply that asks again 'should I?' or says it was rejected/cancelled fails.",
      },
    },
    // --- REJECT COMPANION PATH ---------------------------------------------
    {
      kind: "action",
      name: "seed-second-pending-sign-approval",
      room: "main",
      actionName: "PERSONAL_ASSISTANT",
      text: "Also queue the vendor MSA for signature, again behind my approval.",
      options: {
        action: "sign_document",
        documentName: "Vendor MSA",
        reason: "Vendor MSA needs signature but terms are still under review.",
      },
      assertResponse(text: string) {
        if (!/approval|approve/i.test(text)) {
          return "second seed reply must say the signing flow is gated on approval";
        }
      },
    },
    {
      // Live-LLM resolution: the owner rejects. RESOLVE_REQUEST(reject) flips
      // the live row pending -> rejected and the gated sign/send never runs.
      kind: "message",
      name: "owner-rejects",
      room: "main",
      text: "Actually no — reject the Vendor MSA signing request, do not send it.",
      responseIncludesAny: ["reject", "rejected", "won't", "not send", "held"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "After the owner rejects, the reply must confirm the pending Vendor MSA approval was REJECTED / not sent. A reply that confirms a signature/send went out, or that approves it, fails.",
      },
    },
  ],
  finalChecks: [
    // The resolution capability fired at all (routing floor — not the outcome).
    {
      type: "selectedAction",
      actionName: ["RESOLVE_REQUEST"],
    },
    {
      type: "actionCalled",
      actionName: "RESOLVE_REQUEST",
      status: "success",
      minCount: 1,
    },
    // OUTCOME 1: a real PENDING approval existed before any decision.
    {
      type: "custom",
      name: "approval-pending-seeded",
      predicate: expectPendingApprovalSeeded,
    },
    // OUTCOME 2: APPROVE moved the row pending -> approved/executing/done AND
    // the gated executor ran (the gated side effect actually occurred).
    {
      type: "custom",
      name: "approval-pending-to-approved-executed",
      predicate: expectApproveResolvedAndExecuted,
    },
    // OUTCOME 3: REJECT left the row in 'rejected' with NO sign/send side effect.
    {
      type: "custom",
      name: "approval-reject-no-side-effect",
      predicate: expectRejectNoSideEffect,
    },
    // End-to-end semantic gate over the whole flow.
    {
      type: "judgeRubric",
      name: "approval-resolution-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: a pending approval was created, the owner's approval executed the gated signing flow, and a separately-rejected approval produced no signing/send side effect.",
    },
  ],
});
