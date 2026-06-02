import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "household-staff-background-check",
  title: "Assistant coordinates household staff background checks",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "privacy", "hiring"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Household Staff Background Check",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prepare-household-vetting",
      text: "For the house manager finalist, coordinate references, background-check vendor, NDA status, start-date windows, and household access limits.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "privacy"],
      responseIncludesAny: ["references", "background-check", "NDA", "access"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "draft-vetting-updates",
      text: "Draft updates to the recruiter and family office. Keep address and family details out until I approve the finalist.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["recruiter", "family office", "address", "approve"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
