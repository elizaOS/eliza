import type { AgentRuntime, UUID } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "cross-platform.group-chat-gateway",
  title: "Create a real Discord group handoff room",
  domain: "messaging.cross-platform",
  tags: ["cross-platform", "gateway", "routing", "group-chat"],
  description:
    "A request to create a Discord group handoff should invoke the real gateway action and persist the created room/participants in runtime state.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-Platform Group Chat Gateway",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create group chat",
      room: "main",
      text: "Create a group chat with the agent and Alice on Discord.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "cross-platform group chat creation",
        includesAny: ["create_group_chat", "discord", "Alice"],
      }),
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "MESSAGE",
    },
    {
      type: "custom",
      name: "cross-platform-group-chat-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "cross-platform group chat creation",
        includesAny: ["create_group_chat", "discord", "Alice"],
      }),
    },
    {
      type: "custom",
      name: "cross-platform-group-chat-persists-room",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) {
          return "scenario runtime unavailable";
        }
        const hit = ctx.actionsCalled.find(
          (entry) => entry.actionName === "MESSAGE",
        );
        const data =
          hit?.result?.data && typeof hit.result.data === "object"
            ? (hit.result.data as {
                roomId?: string;
                worldId?: string;
                platform?: string;
                participants?: string[];
                participantEntityIds?: string[];
              })
            : null;
        if (!data?.roomId || !data.worldId) {
          return "expected gateway result to include roomId and worldId";
        }
        if (data.platform !== "discord") {
          return `expected discord platform, got ${data.platform ?? "(missing)"}`;
        }
        if (!data.participants?.includes("Alice")) {
          return "expected Alice in created participant list";
        }
        const room = await runtime.getRoom(data.roomId as UUID);
        if (!room) {
          return `expected persisted room ${data.roomId}`;
        }
        if (room.source !== "discord") {
          return `expected room source discord, got ${room.source ?? "(missing)"}`;
        }
        const participantIds = await runtime.getParticipantsForRoom(
          data.roomId as UUID,
        );
        if (!participantIds.includes(runtime.agentId)) {
          return "expected the assistant to be a participant in the handoff room";
        }
        for (const entityId of data.participantEntityIds ?? []) {
          if (!participantIds.includes(entityId as UUID)) {
            return `expected participant ${entityId} in the handoff room`;
          }
        }
        return undefined;
      },
    },
  ],
});
