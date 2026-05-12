/**
 * Discord bot token expired — agent must surface failure and prompt the
 * user to refresh the bot token rather than silently dropping Discord
 * from cross-channel summaries.
 *
 * Failure modes guarded:
 *   - silently omitting Discord from summaries
 *   - generic "something went wrong" without naming the cause
 *
 * Cited: 03-coverage-gap-matrix.md — Discord token expiry path.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

function checkDiscordExpirySurfaced(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty reply on discord token expiry";
  const discordSignals = [
    "discord",
    "token",
    "expired",
    "reauthenticate",
    "reauth",
    "reconnect",
    "refresh",
    "credentials",
    "not authorized",
  ];
  if (!discordSignals.some((s) => reply.includes(s))) {
    return `Agent did not surface Discord token expiry. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "cross-channel.discord-bot-token-expired",
  title: "Discord bot token expired surfaces explicit reauth prompt",
  domain: "lifeops.cross-channel",
  tags: [
    "lifeops",
    "cross-channel",
    "discord",
    "token-expiry",
    "negative-path",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Discord Token Expired",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-discord-summary",
      room: "main",
      text: "What's been happening in my Discord groups today? (My bot token might have expired, just FYI.)",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "discord-expiry-surfaced",
      predicate: checkDiscordExpirySurfaced,
    },
    judgeRubric({
      name: "cross-channel-discord-expiry-rubric",
      threshold: 0.7,
      description:
        "Agent surfaces Discord token expiry honestly and prompts a reconnect, instead of silently returning no data or fabricating discord chat content.",
    }),
  ],
});
