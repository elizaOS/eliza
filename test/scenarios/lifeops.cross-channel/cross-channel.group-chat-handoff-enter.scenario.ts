/**
 * Group-chat handoff — enter. User asks agent to join an existing group chat
 * to take over responses. Agent must create the handoff room and confirm
 * participation.
 *
 * Failure modes guarded:
 *   - skipping room creation / participant registration
 *   - claiming to have joined without persisting the room
 *
 * Cited: 03-coverage-gap-matrix.md — handoff enter.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

function checkHandoffRoomPersisted(ctx: ScenarioContext): string | undefined {
  const runtime = ctx.runtime as AgentRuntime | undefined;
  if (!runtime) return "scenario runtime unavailable";
  const hit = ctx.actionsCalled.find((a) => a.actionName === "MESSAGE");
  if (!hit) return "expected MESSAGE action to create handoff room";
  const data =
    hit.result?.data && typeof hit.result.data === "object"
      ? (hit.result.data as { roomId?: string; platform?: string })
      : null;
  if (!data?.roomId) {
    return "expected MESSAGE result.data.roomId from handoff creation";
  }
  return undefined;
}

export default scenario({
  id: "cross-channel.group-chat-handoff-enter",
  title: "Agent enters existing group chat as handoff participant",
  domain: "lifeops.cross-channel",
  tags: ["lifeops", "cross-channel", "handoff", "group-chat"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Handoff Enter",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-handoff-join",
      room: "main",
      text: "Join the Discord group chat with Alice, Bob, and Carol and take over my replies there for the next hour.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "MESSAGE",
    },
    {
      type: "custom",
      name: "handoff-room-persisted",
      predicate: checkHandoffRoomPersisted,
    },
    {
      type: "custom",
      name: "handoff-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "group chat handoff entry",
        includesAny: ["discord", "alice", "bob", "carol", "handoff", "join"],
      }),
    },
    judgeRubric({
      name: "cross-channel-handoff-enter-rubric",
      threshold: 0.7,
      description:
        "Agent created a persisted handoff room joining Alice/Bob/Carol on Discord and confirmed participation.",
    }),
  ],
});
