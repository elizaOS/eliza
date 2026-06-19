import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "lease-renewal-option-window",
  title: "Assistant protects lease renewal option window",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "legal", "vendor"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Lease Renewal Option Window",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-renewal-window",
      text: "Find the renewal option window for the pied-a-terre lease, rent escalator, notice method, landlord contact, and any broker obligations.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "SCHEDULED_TASKS", "priority"],
      responseIncludesAny: ["renewal", "notice", "landlord", "broker"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-renewal-notice",
      text: "Draft the renewal notice and a broker follow-up. Ask me before sending the legal notice or committing to the escalator.",
      plannerIncludesAny: ["owner_send_message", "approval", "SCHEDULED_TASKS"],
      responseIncludesAny: ["renewal notice", "broker", "sending", "escalator"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
