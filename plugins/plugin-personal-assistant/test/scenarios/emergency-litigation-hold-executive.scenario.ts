import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "emergency-litigation-hold-executive",
  title: "Assistant coordinates emergency executive litigation hold",
  domain: "executive.legal",
  tags: ["lifeops", "executive-assistant", "legal", "privacy", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Emergency Litigation Hold Executive",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "identify-hold-custodians",
      text: "Counsel needs an emergency hold. Identify executive custodians, relevant threads, document systems, travel devices, and a deadline for acknowledgment.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "deadline", "privacy"],
      responseIncludesAny: ["custodians", "threads", "devices", "acknowledgment"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "draft-hold-routing",
      text: "Draft the hold routing note and acknowledgment tracker. Do not send the notice until counsel approves the recipient list.",
      plannerIncludesAny: ["owner_send_message", "approval", "SCHEDULED_TASKS"],
      responseIncludesAny: ["routing", "tracker", "counsel", "recipient list"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
