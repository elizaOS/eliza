/**
 * Group-chat handoff — resume. Agent was previously delegated to a group;
 * user asks "what did people say while I was away?". Agent must summarize
 * what happened during the handoff window.
 *
 * Failure modes guarded:
 *   - summarizing the wrong window
 *   - fabricating activity not in the seeded log
 *
 * Cited: 03-coverage-gap-matrix.md — handoff resume / catch-up.
 */

import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "cross-channel.group-chat-handoff-resume",
  title: "Resume after handoff — agent catches user up on group chat",
  domain: "lifeops.cross-channel",
  tags: ["lifeops", "cross-channel", "handoff", "resume", "catchup"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Handoff Resume",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-catchup",
      room: "main",
      text: "I'm back from lunch — what happened in the Discord group chat with Alice and Bob while I was away?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "handoff-resume-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "READ_MESSAGES"],
        description: "handoff resume catch-up across discord group",
        includesAny: ["discord", "alice", "bob", "catch", "summary"],
      }),
    },
    judgeRubric({
      name: "cross-channel-handoff-resume-rubric",
      threshold: 0.7,
      description:
        "Agent summarized group-chat activity during the handoff window without fabricating messages it didn't see.",
    }),
  ],
});
