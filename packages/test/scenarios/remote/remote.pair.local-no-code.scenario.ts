import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulCalls,
  toRecord,
} from "../_helpers/effect-assertions.ts";

function expectLocalPairingGuidance(ctx: ScenarioContext): string | undefined {
  const call = successfulCalls(ctx, "LIST_ACTIVE_BLOCKS")[0];
  const data = toRecord(call?.result?.data);
  if (!data || !Array.isArray(data.rules)) {
    return `expected LIST_ACTIVE_BLOCKS to read the live rules array before local pairing guidance; calls: ${describeCalls(ctx)}`;
  }

  const reply = ctx.turns?.at(-1)?.responseText ?? "";
  if (!/(pair|connect|same machine|same network|local|device)/i.test(reply)) {
    return `expected in-device local pairing guidance, saw ${JSON.stringify(reply)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "remote.pair.local-no-code",
  title: "Local pairing request returns in-device instructions",
  domain: "remote",
  tags: ["remote", "pairing", "local"],
  description:
    "A local pairing request currently responds with in-device pairing guidance on the same network.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Remote Pair Local No Code",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "pair-locally",
      room: "main",
      text: "Pair my companion client. I'm on the same machine.",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "local-pairing-guidance-reads-active-block-state",
      predicate: expectLocalPairingGuidance,
    },
  ],
});
