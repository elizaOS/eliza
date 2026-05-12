/**
 * Sleep: sleep-window protection — user is asleep (between 23:00 and 07:00
 * local) and a 6am call request comes in. The agent should reject or buffer
 * the scheduling action until after wake-up.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { seedMeetingPreferences } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "sleep.sleep-window-protection-enforcement",
  title: "Sleep window protects user from being scheduled before wake-up",
  domain: "lifeops.sleep",
  tags: ["lifeops", "sleep", "protection", "scheduling"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Sleep Window Protection",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-sleep-window-prefs",
      apply: seedMeetingPreferences({
        timeZone: "America/Los_Angeles",
        preferredStartLocal: "09:00",
        preferredEndLocal: "18:00",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "early-call-request",
      text: "Can you schedule a 6am call with the team for tomorrow?",
      responseIncludesAny: [
        "6am",
        "early",
        "sleep",
        "later",
        "after",
        "9",
        "wake",
      ],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-protects-sleep-window",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(
          ctx.turns?.[0]?.responseText ?? "",
        ).toLowerCase();
        if (!reply) return "empty reply";
        const protected_ =
          reply.includes("early") ||
          reply.includes("sleep") ||
          reply.includes("later") ||
          reply.includes("after") ||
          reply.includes("wake") ||
          reply.includes("9");
        if (!protected_) {
          return `agent should push back on 6am scheduling. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
