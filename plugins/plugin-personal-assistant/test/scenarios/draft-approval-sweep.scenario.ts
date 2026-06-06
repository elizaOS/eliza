import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "draft-approval-sweep",
  title: "Assistant surfaces stale unsent drafts for approval",
  domain: "executive.approvals",
  tags: ["lifeops", "executive-assistant", "approvals", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Draft Approval Sweep",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "list-pending-drafts",
      text: "What outbound drafts are waiting on my approval, and which ones become awkward if they sit another day?",
      plannerIncludesAny: ["BRIEF", "SCHEDULED_TASKS", "owner_send_message"],
      responseIncludesAny: ["approval", "draft", "waiting", "priority"],
      plannerExcludes: ["calendar_action", "spawn_agent", "send_to_agent"],
    },
    {
      kind: "message",
      name: "approve-one-not-all",
      text: "Send only the vendor reply. Leave the investor note as a draft and remind me again tonight.",
      plannerIncludesAll: ["owner_send_message"],
      plannerIncludesAny: ["SCHEDULED_TASKS", "vendor", "investor", "remind"],
      responseIncludesAny: ["vendor", "draft", "reminder"],
      plannerExcludes: ["gmail_action"],
    },
  ],
});
