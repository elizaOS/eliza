/** Proves muting a Discord-local room changes the authoritative participant state. */

import type { AgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";

const muteParameters: {
  action: "mute";
  platform: "discord-local";
  roomId?: string;
} = {
  action: "mute",
  platform: "discord-local",
};

export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "discord.local.mute-channel",
  title: "Discord-local mute changes authoritative room state",
  domain: "messaging.discord-local",
  tags: ["messaging", "discord", "mute", "state-transition"],
  description:
    "Invokes the canonical MUTE_ROOM action in a Discord-local room and verifies authoritative runtime participant state rather than accepting a transcript claim.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "discord-local",
      channelType: "GROUP",
      title: "gm",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "bind-exact-discord-room-id",
      apply: (ctx) => {
        if (!ctx.primaryRoomId) return "primary room unavailable";
        muteParameters.roomId = ctx.primaryRoomId;
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "mute-gm-room",
      room: "main",
      text: "Mute this Discord #gm channel.",
      actionName: "ROOM",
      options: { parameters: muteParameters },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "discord-room-is-authoritatively-muted",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime || !ctx.primaryRoomId) {
          return "scenario runtime or primary room unavailable";
        }
        const state = await runtime.getParticipantUserState(
          ctx.primaryRoomId,
          runtime.agentId,
        );
        return state === "MUTED"
          ? undefined
          : `expected MUTED participant state, saw ${state ?? "(missing)"}`;
      },
    },
    {
      type: "connectorDispatchOccurred",
      channel: "discord-local",
      expected: false,
      maxCount: 0,
    },
  ],
});
