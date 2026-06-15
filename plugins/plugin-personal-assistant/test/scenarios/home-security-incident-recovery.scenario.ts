import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "home-security-incident-recovery",
  title: "Assistant recovers a home security incident",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "privacy", "vendor"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Home Security Incident Recovery",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-home-security",
      text: "The gate camera caught an unknown contractor. Build the response plan: security vendor, house manager, access logs, neighbor camera request, and family notification limits.",
      plannerIncludesAny: ["owner_send_message", "privacy", "SCHEDULED_TASKS"],
      responseIncludesAny: ["security vendor", "access logs", "neighbor", "limits"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-security-followups",
      text: "Draft messages to the security vendor and house manager, but do not share family travel details unless I approve.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["vendor", "house manager", "travel details", "approve"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
