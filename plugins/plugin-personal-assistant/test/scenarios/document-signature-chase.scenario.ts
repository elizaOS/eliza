/**
 * Live-model NDA signature-chase (#9310): seeds a real pending sign_document
 * approval on the live queue for the partner NDA, resolves it through the live
 * RESOLVE_REQUEST action, and asserts the queue outcome (pending ->
 * approved/executing/done). The close-out turn is judged on loop-closure
 * semantics rather than prompt echoes.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectApprovalResolvedApproved,
  expectPendingApprovalSeeded,
} from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "document-signature-chase",
  title:
    "NDA signature chase: pending approval resolves and the loop closes after signing",
  domain: "executive.documents",
  tags: ["lifeops", "executive-assistant", "documents", "approvals", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "LifeOps Document Signature Chase",
    },
  ],
  turns: [
    {
      // Deterministic seed: real PENDING approval row for the NDA chase.
      kind: "action",
      name: "seed-pending-nda-chase-approval",
      room: "main",
      actionName: "PERSONAL_ASSISTANT",
      text: "Get the partner NDA signed by Priya by Friday. Track the deadline and hold the chase note for my approval.",
      options: {
        action: "sign_document",
        documentName: "Partner NDA",
        reason:
          "Priya must countersign the partner NDA by Friday; chase note is gated on owner approval.",
      },
      assertResponse(text: string) {
        if (!/approval|approve/i.test(text)) {
          return "seed reply must say the NDA chase is gated on approval";
        }
      },
    },
    {
      // Live-LLM resolution: the owner approves the chase.
      kind: "message",
      name: "owner-approves-nda-chase",
      room: "main",
      text: "Yes — approve the Partner NDA request and send the chase note.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "After the owner explicitly approves, the reply must confirm the pending Partner NDA approval was APPROVED and the chase is going out. Asking for confirmation again or reporting a rejection fails.",
      },
    },
    {
      kind: "message",
      name: "close-after-signed",
      room: "main",
      text: "Priya signed it. Close the request and stop chasing.",
      // Loop-closure semantics that are NOT echoes of this turn's wording.
      responseIncludesAny: ["closed", "marked", "wrapped", "no further"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must confirm the signature was recorded and the chase is closed — no further reminders or sends will fire. Scheduling more chasing after the document is signed fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "nda-approval-pending-seeded",
      predicate: expectPendingApprovalSeeded("Partner NDA"),
    },
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
    {
      type: "custom",
      name: "nda-approval-pending-to-approved",
      predicate: expectApprovalResolvedApproved(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "signature-chase-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: a pending NDA-chase approval was created on the queue, the owner's approval resolved it so the chase could execute, and once the document was signed the assistant closed the loop instead of continuing to chase.",
    },
  ],
});
