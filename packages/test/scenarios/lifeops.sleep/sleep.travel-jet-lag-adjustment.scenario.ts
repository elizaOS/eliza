/**
 * Sleep: travel jet-lag adjustment — user just landed in Tokyo, 17 hours
 * ahead of Pacific. The agent should adjust sleep recommendations gradually
 * rather than telling the user to sleep at 11pm Tokyo time immediately.
 */

import { scenario } from "@elizaos/scenario-schema";
import { seedMeetingPreferences } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "sleep.travel-jet-lag-adjustment",
  title: "Jet-lag adjustment recommends gradual sleep-time shift",
  domain: "lifeops.sleep",
  tags: ["lifeops", "sleep", "travel", "jet-lag"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Sleep Jet Lag",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-tokyo-tz",
      apply: seedMeetingPreferences({
        timeZone: "Asia/Tokyo",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "jet-lag-prompt",
      text: "I just landed in Tokyo from SF. Help me adjust my sleep schedule.",
      responseIncludesAny: ["tokyo", "sleep", "adjust", "lag", "gradual"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-suggests-gradual-shift",
      predicate: (ctx) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
        if (!reply) return "empty reply";
        const sensible =
          reply.includes("gradual") ||
          reply.includes("hour") ||
          reply.includes("over") ||
          reply.includes("light") ||
          reply.includes("morning") ||
          reply.includes("shift");
        if (!sensible) {
          return `agent should offer gradual jet-lag advice. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
