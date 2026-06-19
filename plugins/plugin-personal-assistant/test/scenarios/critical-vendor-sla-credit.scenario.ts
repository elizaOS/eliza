import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "critical-vendor-sla-credit",
  title: "Assistant recovers critical vendor SLA credit",
  domain: "executive.vendor",
  tags: ["lifeops", "executive-assistant", "vendor", "legal", "followup"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Critical Vendor SLA Credit",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-sla-credit",
      text: "Our critical vendor missed uptime targets. Gather contract SLA terms, incident timestamps, support tickets, credit notice window, and renewal leverage.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "SCHEDULED_TASKS", "priority"],
      responseIncludesAny: ["SLA", "timestamps", "credit", "renewal"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-vendor-claim",
      text: "Draft the SLA credit claim and renewal negotiation note. Ask before sending the claim or threatening termination.",
      plannerIncludesAny: ["owner_send_message", "approval", "SCHEDULED_TASKS"],
      responseIncludesAny: ["claim", "renewal", "sending", "termination"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
