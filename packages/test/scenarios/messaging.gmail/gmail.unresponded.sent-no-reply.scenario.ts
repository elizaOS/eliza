import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.unresponded.sent-no-reply",
  title: "Find sent Gmail threads with no later human reply",
  domain: "messaging.gmail",
  tags: ["messaging", "gmail", "unresponded", "followup", "read-only"],
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
      title: "Gmail Unresponded Threads",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "followup-14-days-ago.eml",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "find unresponded sent threads",
      room: "main",
      text: "Who have I emailed from Gmail and not heard back from in the last two weeks? Do not draft or send anything yet.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must identify the stale Gmail thread where the owner sent a follow-up and no later human reply arrived. It must not draft, send, archive, delete, or report anything.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: "unresponded",
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      minCount: 1,
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/threads",
      minCount: 1,
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
      name: "gmail-unresponded-thread-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant used thread chronology to find a true unresponded Gmail thread and did not turn the read-only check into a draft or send.",
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
