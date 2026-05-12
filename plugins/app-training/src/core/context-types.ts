export const AGENT_CONTEXTS = [
  "general",
  "finance",
  "crypto",
  "wallet",
  "payments",
  "documents",
  "browser",
  "code",
  "media",
  "automation",
  "social",
  "system",
] as const;

export type AgentContext = (typeof AGENT_CONTEXTS)[number];
