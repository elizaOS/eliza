import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "school-family-calendar-carpool",
  title: "Assistant reconciles family school logistics with work calendar pressure",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "calendar"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps School Family Calendar",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "resolve-carpool-conflict",
      text: "The school pickup moved to 3:15 and it conflicts with my investor call. Find a carpool option and draft the message to the parent thread.",
      plannerIncludesAny: ["CONFLICT_DETECT", "CALENDAR", "owner_send_message"],
      responseIncludesAny: ["conflict", "pickup", "draft"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "protect-family-followup",
      text: "If nobody replies by noon tomorrow, remind me and suggest moving the investor call by 30 minutes.",
      plannerIncludesAll: ["SCHEDULED_TASKS"],
      plannerIncludesAny: ["noon", "tomorrow", "investor"],
      responseIncludesAny: ["reminder", "noon", "investor"],
      plannerExcludes: ["send_to_agent"],
    },
  ],
});
