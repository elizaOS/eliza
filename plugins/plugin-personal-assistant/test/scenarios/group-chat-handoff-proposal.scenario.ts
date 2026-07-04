/**
 * Live-model group-chat handoff proposal (#9310): the capability under test is
 * proposing a handoff INSTEAD of sending. Asserts (1) the intro draft was
 * materialized through a real messaging action whose captured arguments carry both
 * counterparties (selectedActionArguments — Maya AND Jordan in the action args,
 * not just the reply), and (2) nothing was dispatched on an external send channel
 * before approval — the negative space is the assertion.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "group-chat-handoff-proposal",
  title:
    "Group-chat handoff drafts an intro with both counterparties and sends nothing",
  domain: "executive.messaging",
  tags: ["lifeops", "executive-assistant", "messaging", "handoff", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "LifeOps Group Chat Handoff",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "handoff-better-than-relay",
      room: "main",
      text: "Coordinate with Maya and Jordan about the venue. If relaying through me will be messy, propose a group chat handoff instead of sending anything.",
      plannerExcludes: ["calendar_action", "gmail_action"],
      responseExcludes: ["already sent", "i've sent", "i have sent", "sent it"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must recommend the group-chat handoff over relaying (with a reason), name both Maya and Jordan as participants, and make clear nothing has been sent yet. Silently starting to relay messages, or claiming a send happened, fails.",
      },
    },
    {
      kind: "message",
      name: "owner-approves-intro",
      room: "main",
      text: "Okay, draft the intro and keep me on the thread.",
      plannerExcludes: ["spawn_agent", "send_to_agent"],
      responseExcludes: ["already sent", "i've sent", "i have sent"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must present the actual intro draft text (addressing Maya and Jordan about the venue, keeping the owner on the thread) staged for approval — not a promise to draft it later, and not a claim that it was sent.",
      },
    },
  ],
  finalChecks: [
    // OUTCOME: the intro draft went through a real messaging action whose
    // captured arguments carry BOTH counterparties.
    {
      type: "selectedActionArguments",
      name: "intro-draft-args-carry-both-parties",
      actionName: ["MESSAGE", "GMAIL_ACTION", "INBOX"],
      includesAll: ["maya", "jordan"],
    },
    // NEGATIVE OUTCOME: nothing was dispatched externally before approval.
    {
      type: "custom",
      name: "handoff-nothing-sent-before-approval",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "group-chat-handoff-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the assistant proposed a group-chat handoff instead of brittle relaying, staged an intro draft that includes both Maya and Jordan with the owner kept on-thread, and dispatched nothing before approval.",
    },
  ],
});
