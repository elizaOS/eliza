import type { AgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-schema";
import { expectTurnToCallAction } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "discord.local.mute-channel",
  title: "Discord mute request updates the live room mute state",
  domain: "messaging.discord-local",
  tags: ["messaging", "discord", "routing", "state-transition"],
  description:
    "A Discord channel mute request should invoke MUTE_ROOM and leave the live participant state set to MUTED.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Discord Local Mute",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mute gm channel",
      room: "main",
      text: "Mute the #gm channel",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MUTE_ROOM"],
        description: "discord mute room action",
        includesAny: ["Muted", "muted"],
      }),
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "MUTE_ROOM",
    },
    {
      type: "custom",
      name: "discord-local-mute-routing",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) {
          return "scenario runtime unavailable";
        }
        const muteAction = ctx.actionsCalled.find(
          (entry) => entry.actionName === "MUTE_ROOM",
        );
        if (!muteAction) {
          return "expected MUTE_ROOM to be called";
        }
        const data =
          muteAction.result?.data && typeof muteAction.result.data === "object"
            ? (muteAction.result.data as {
                muted?: boolean;
                roomId?: string;
                roomName?: string;
              })
            : null;
        if (!data?.muted) {
          return "expected MUTE_ROOM result with muted=true";
        }
        if (typeof data.roomId !== "string" || data.roomId.length === 0) {
          return "expected MUTE_ROOM result to include roomId";
        }
        const currentState = await runtime.getParticipantUserState(
          data.roomId,
          runtime.agentId,
        );
        if (currentState !== "MUTED") {
          return `expected live participant user state MUTED, got ${currentState ?? "(missing)"}`;
        }
        return undefined;
      },
    },
  ],
});
