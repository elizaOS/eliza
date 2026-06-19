import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "data-breach-vendor-notification",
  title: "Assistant runs a vendor breach notification and containment loop",
  domain: "executive.escalation",
  tags: ["lifeops", "executive-assistant", "security", "legal", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Vendor Breach Notification",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-breach-scope",
      text: "Our payroll vendor says some employee tax records may have been exposed. Build the containment checklist, identify counsel and HR owners, and summarize what we know without guessing.",
      plannerIncludesAny: ["privacy", "OWNER_DOCUMENTS", "delegation"],
      responseIncludesAny: ["payroll", "counsel", "HR", "containment"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "draft-need-to-know-updates",
      text: "Draft separate need-to-know notes for the CEO, HR lead, outside counsel, and affected employees. Do not send anything until legal approves.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["CEO", "HR", "counsel", "approval"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
