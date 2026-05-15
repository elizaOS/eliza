/**
 * Signal permission denied — Signal connector is degraded / not authorized.
 * Agent must continue with available channels and report Signal as
 * unavailable rather than silently dropping it.
 *
 * Failure modes guarded:
 *   - silently omitting Signal from cross-channel summaries
 *   - hard-failing the whole multi-channel query because one channel is down
 *
 * Cited: 03-coverage-gap-matrix.md — Signal permission denied path.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

function checkSignalUnavailableSurfaced(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty reply on signal-denied query";
  const signalSignals = [
    "signal",
    "not connected",
    "permission",
    "denied",
    "unavailable",
    "not authorized",
    "can't access",
    "cannot access",
    "no access",
  ];
  if (!signalSignals.some((s) => reply.includes(s))) {
    return `Agent did not surface signal-unavailable state. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "cross-channel.signal-permission-denied-degraded",
  title:
    "Signal permission denied → degraded but cross-channel query continues",
  domain: "lifeops.cross-channel",
  tags: [
    "lifeops",
    "cross-channel",
    "degraded",
    "signal",
    "permission",
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
      title: "Signal Denied",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-cross-channel-with-signal-denied",
      room: "main",
      text: "Pull together my messages from Signal, Telegram, and Gmail today. (FYI Signal lost permission this morning.)",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "signal-unavailable-surfaced",
      predicate: checkSignalUnavailableSurfaced,
    },
    judgeRubric({
      name: "cross-channel-signal-denied-rubric",
      threshold: 0.7,
      description:
        "Agent surfaces Signal as unavailable / permission-denied and still summarizes Telegram + Gmail. Does not pretend Signal contributed data.",
    }),
  ],
});
