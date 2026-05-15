import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.bulk.apply-label.name-resolution",
  title: "Resolve Gmail label name before applying it",
  domain: "messaging.gmail",
  tags: ["messaging", "gmail", "bulk", "label", "inbox-zero"],
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
      title: "Gmail Label Name Resolution",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
      requiredMessageIds: ["msg-finance"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "select finance message",
      room: "main",
      text: "Find the Gmail invoice message that needs filing under the existing label named eliza-e2e. Do not change anything yet.",
      responseJudge: {
        minimumScore: 0.72,
        rubric:
          "The assistant must identify the finance/invoice Gmail message as the target and keep this step read-only.",
      },
    },
    {
      kind: "message",
      name: "apply resolved label",
      room: "main",
      text: "Apply the existing Gmail label named eliza-e2e to that selected finance message only. I confirm this Gmail label change.",
      responseJudge: {
        minimumScore: 0.78,
        rubric:
          "The assistant must resolve the human label name through Gmail labels, apply only the resolved label to the previously selected finance message, and not silently create or guess a different label.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: ["search", "read"],
      minCount: 1,
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/labels",
      minCount: 1,
    },
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: "manage",
      operation: "apply_label",
      fields: {
        labelIds: "Label_1",
      },
    },
    {
      type: "gmailBatchModify",
      body: {
        addLabelIds: "Label_1",
      },
    },
    {
      type: "gmailDraftCreated",
      expected: false,
    },
    {
      type: "gmailMessageSent",
      expected: false,
    },
    {
      type: "gmailNoRealWrite",
    },
    judgeRubric({
      name: "gmail-label-name-resolution-rubric",
      threshold: 0.78,
      description:
        "End-to-end: the assistant selected the finance message first, resolved the existing Gmail label name to its Gmail label ID, and applied that label without drafting, sending, or guessing.",
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
