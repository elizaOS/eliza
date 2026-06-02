import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.document-signature-review",
  title: "Document review finds signatures, redlines, and approvals",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "documents", "approvals"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Document review" },
  ],
  turns: [
    {
      kind: "message",
      name: "document-review",
      room: "main",
      text: "Scan recent docs and attachments for signature, redline, notarization, upload, review, or approval work. Create tasks only for explicit approvals.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["OWNER_DOCUMENTS", "MESSAGE", "LIFE", "RESOLVE_REQUEST"],
        description: "document approval review",
        includesAny: ["signature", "redline", "notarization", "upload", "approval"],
      }),
      responseIncludesAny: [/signature|redline|approval|notar/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should distinguish document tasks by type and only create approval tasks when approval is explicit.",
      },
    },
  ],
  finalChecks: [
    { type: "selectedAction", actionName: ["OWNER_DOCUMENTS", "MESSAGE", "LIFE", "RESOLVE_REQUEST"] },
    {
      type: "custom",
      name: "document-review-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["OWNER_DOCUMENTS", "MESSAGE", "LIFE", "RESOLVE_REQUEST"],
        description: "document approval review",
        includesAny: ["signature", "redline", "notarization", "upload", "approval"],
      }),
    },
    judgeRubric({
      name: "executive-document-review-rubric",
      threshold: 0.7,
      description:
        "Agent separates signatures, redlines, uploads, notarization, and approvals without over-creating tasks.",
    }),
  ],
});
