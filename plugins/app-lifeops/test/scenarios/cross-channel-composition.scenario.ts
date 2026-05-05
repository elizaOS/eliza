import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "cross-channel-composition",
  title: "Cross-channel composition drafts a message for approval",
  domain: "messaging.cross-platform",
  tags: ["lifeops", "messaging", "cross-channel", "llm-eval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Cross-Channel Composition",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "compose-email-draft",
      text: "Email alice@example.com the notes from today. Draft it for my approval; do not send it yet.",
      plannerIncludesAll: ["owner_send_message", "alice@example.com"],
      plannerIncludesAny: ["email", "notes", "draft"],
      plannerExcludes: ["calendar_action", "gmail_action"],
      responseIncludesAny: ["draft", "approval", "alice@example.com"],
    },
    {
      kind: "message",
      name: "composition-policy-not-send",
      text: "If direct relaying gets messy here, suggest a group chat handoff instead.",
      plannerIncludesAll: ["owner_send_message"],
      responseIncludesAny: ["group chat", "handoff", "relay"],
      plannerExcludes: ["calendar_action", "gmail_action"],
    },
  ],
});
