import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "domain-renewal-admin-takeover",
  title: "Assistant recovers domain renewal admin takeover",
  domain: "executive.vendor",
  tags: ["lifeops", "executive-assistant", "vendor", "security", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Domain Renewal Admin Takeover",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-domain-renewal",
      text: "A critical domain renewal is stuck with an old admin. Find registrar, renewal date, admin email, ownership proof, DNS risk, and transfer steps.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "SCHEDULED_TASKS", "priority"],
      responseIncludesAny: ["registrar", "renewal", "admin", "DNS"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-admin-recovery",
      text: "Draft registrar support and old-admin outreach. Ask before sharing ownership docs or changing DNS settings.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["registrar", "outreach", "ownership", "DNS"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
