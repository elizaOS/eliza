import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "vendor-access-revocation",
  title: "Assistant coordinates vendor access revocation",
  domain: "executive.vendor",
  tags: ["lifeops", "executive-assistant", "vendor", "security", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Vendor Access Revocation",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-vendor-access",
      text: "The design agency contract ended. Map every access point to revoke: shared drives, calendar invites, Slack channels, invoices, and physical badge list.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "owner_send_message", "privacy"],
      responseIncludesAny: ["shared drives", "calendar", "Slack", "badge"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "draft-revocation-notices",
      text: "Draft revocation notices for IT, finance, facilities, and the vendor lead. Ask before sending anything externally.",
      plannerIncludesAny: ["owner_send_message", "approval", "SCHEDULED_TASKS"],
      responseIncludesAny: ["IT", "finance", "facilities", "externally"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
