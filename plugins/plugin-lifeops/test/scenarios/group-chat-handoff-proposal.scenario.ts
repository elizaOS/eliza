import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "group-chat-handoff-proposal",
  title: "Assistant proposes group-chat handoff instead of brittle relaying",
  domain: "executive.messaging",
  tags: ["lifeops", "executive-assistant", "messaging", "handoff"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Group Chat Handoff",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "handoff-better-than-relay",
      text: "Coordinate with Maya and Jordan about the venue. If relaying through me will be messy, propose a group chat handoff instead of sending anything.",
      plannerIncludesAll: ["owner_send_message"],
      plannerIncludesAny: ["group chat", "handoff", "maya", "jordan"],
      responseIncludesAny: ["group chat", "handoff", "approval", "draft"],
      plannerExcludes: ["calendar_action", "gmail_action"],
    },
    {
      kind: "message",
      name: "owner-approves-intro",
      text: "Okay, draft the intro and keep me on the thread.",
      plannerIncludesAll: ["owner_send_message"],
      plannerIncludesAny: ["intro", "thread", "draft"],
      responseIncludesAny: ["draft", "approval", "thread"],
      plannerExcludes: ["spawn_agent", "send_to_agent"],
    },
  ],
});
