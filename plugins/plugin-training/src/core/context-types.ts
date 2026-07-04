/** Canonical `AgentContext` category union shared by the context catalog, audit, and roleplay dataset builders. */

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
