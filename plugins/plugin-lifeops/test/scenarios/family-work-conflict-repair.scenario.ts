import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "family-work-conflict-repair",
  title: "Assistant repairs a family logistics conflict without over-sharing",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "calendar", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Family Work Conflict Repair",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "detect-family-work-conflict",
      text: "Check if school pickup conflicts with the customer call tomorrow. If it does, propose the least disruptive repair and draft only the work-facing note.",
      plannerIncludesAny: ["calendar_action", "family", "draft"],
      responseIncludesAny: ["pickup", "conflict", "draft", "repair"],
      plannerExcludes: ["OWNER_HEALTH", "OWNER_FINANCES"],
    },
    {
      kind: "message",
      name: "avoid-family-overshare",
      text: "Do not mention school or family details in the customer note; just say I need to move the meeting.",
      plannerIncludesAny: ["owner_send_message", "privacy", "customer"],
      responseIncludesAny: ["draft", "move", "meeting", "private"],
      plannerExcludes: ["OWNER_DOCUMENTS"],
    },
  ],
});
