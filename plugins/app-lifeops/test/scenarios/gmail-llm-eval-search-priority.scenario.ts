import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "gmail-llm-eval-search-priority",
  title: "Gmail LLM evals cover cross-account search and priority triage",
  domain: "gmail",
  tags: ["lifeops", "gmail", "email", "llm-eval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Gmail LLM Eval Search Priority",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "gmail-cross-account-search",
      text: "Search Gmail for a colleague across my personal and work accounts.",
      plannerIncludesAll: ["gmail_action"],
      plannerIncludesAny: ["personal", "work", "account", "colleague", "search"],
      plannerExcludes: ["calendar_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "gmail-multi-search",
      text: "Find emails from a colleague about the report and the venue.",
      plannerIncludesAll: ["gmail_action"],
      plannerIncludesAny: ["report", "venue", "search", "colleague"],
      plannerExcludes: ["calendar_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "gmail-priority-items",
      text: "Show urgent blockers first and separate them from low-priority newsletters.",
      plannerIncludesAll: ["gmail_action"],
      plannerIncludesAny: ["triage", "priority", "urgent", "blockers"],
      plannerExcludes: ["calendar_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "gmail-vague-broad-help",
      text: "Can you help me with my email?",
      plannerIncludesAll: ["gmail_action"],
      responseIncludesAny: ["search", "read", "draft", "inbox", "Gmail"],
      plannerExcludes: ["calendar_action", "owner_send_message"],
    },
  ],
});
