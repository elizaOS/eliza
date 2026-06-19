import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "cyber-insurance-notice-window",
  title: "Assistant coordinates cyber-insurance notice window",
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
      title: "LifeOps Cyber Insurance Notice Window",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-cyber-notice",
      text: "The security team says cyber-insurance notice may be due. Gather policy notice deadline, incident timeline, broker contact, counsel notes, and evidence preservation asks.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "deadline", "privacy"],
      responseIncludesAny: ["policy", "timeline", "broker", "preservation"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-cyber-notice",
      text: "Draft the notice checklist and broker email, but hold any external notice until counsel approves the incident description.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["checklist", "broker", "external", "counsel"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
