import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Evening recap generation (#8795 item 6). Fills the recap gap: the owner asks
 * for an end-of-day recap that summarizes what got done, what slipped, and what
 * needs them tomorrow — routing to the BRIEF surface (evening period).
 */
export default scenario({
  lane: "live-only",
  id: "evening-recap-generation",
  title: "End-of-day recap summarizes done, slipped, and tomorrow's asks",
  domain: "executive.briefing",
  tags: ["lifeops", "briefing", "recap", "evening"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Evening Recap",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "evening-recap",
      text: "Give me my evening recap: what I finished, what slipped, and what needs me tomorrow.",
      plannerIncludesAny: ["BRIEF", "recap", "evening"],
      responseIncludesAny: ["finished", "slipped", "tomorrow", "recap", "done"],
      plannerExcludes: ["spawn_agent", "send_to_agent", "list_agents"],
    },
    {
      kind: "message",
      name: "carry-forward",
      text: "Carry anything I didn't finish into tomorrow's plan.",
      plannerIncludesAny: [
        "BRIEF",
        "PRIORITIZE",
        "OWNER_TODOS",
        "tomorrow",
        "carry",
      ],
      responseIncludesAny: ["tomorrow", "carry", "plan", "moved"],
      plannerExcludes: ["gmail_action"],
    },
  ],
});
