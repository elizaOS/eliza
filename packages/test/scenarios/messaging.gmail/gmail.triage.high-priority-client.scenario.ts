import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.triage.high-priority-client",
  title: "Triage flags high-priority client email",
  domain: "messaging.gmail",
  tags: ["messaging", "gmail", "triage", "parameter-extraction"],
  isolation: "per-scenario",
  requires: {
    credentials: ["gmail:test-owner"],
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Gmail Triage High-Priority",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "sarah-product-brief.eml",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage high priority",
      room: "main",
      text: "Triage my inbox — anything I need to respond to right now?",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must clearly identify the seeded high-priority client email as needing prompt attention. A vague inbox summary without a prioritized client item fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: "triage",
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      minCount: 1,
    },
    {
      type: "gmailNoRealWrite",
    },
    judgeRubric({
      name: "gmail-high-priority-triage-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant prioritized the client email that needs an immediate response instead of flattening everything into a generic inbox summary.",
    }),
  ],
  cleanup: [
    {
      type: "gmailDeleteDrafts",
      account: "test-owner",
      tag: "eliza-e2e",
    },
  ],
});
