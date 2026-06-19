import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "passport-visa-consulate-escalation",
  title: "Assistant escalates a passport and visa blocker before international travel",
  domain: "executive.travel",
  tags: ["lifeops", "executive-assistant", "travel", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Passport Visa Consulate Escalation",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-passport-visa-blocker",
      text: "My passport has only five months left and the visa appointment is still pending. Build the escalation plan: consulate slots, expeditor docs, trip calendar risk, and what I need to sign today.",
      plannerIncludesAny: ["travel", "OWNER_DOCUMENTS", "calendar_action"],
      responseIncludesAny: ["passport", "visa", "consulate", "sign"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-expeditor-approval",
      text: "Draft the expeditor email and a separate note to the host. Hold both until I approve the passport details included.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["expeditor", "host", "passport", "approval"],
      plannerExcludes: ["send_to_agent"],
    },
  ],
});
