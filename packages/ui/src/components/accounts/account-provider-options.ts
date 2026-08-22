/**
 * Static provider metadata shared by account enrollment, provider rows, and
 * capability display. Keeping the catalog outside the dialog prevents
 * presentational components from depending on the enrollment state machine.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";

export type AccountProviderCategory = "chat" | "coding" | "local" | "cloud";

export interface AccountProviderOption {
  id: LinkedAccountProviderId;
  name: string;
  category: AccountProviderCategory;
  description: string;
  eligibility: string[];
  unavailable?: boolean;
}

export const ACCOUNT_PROVIDER_OPTIONS: AccountProviderOption[] = [
  {
    id: "anthropic-subscription",
    name: "Claude subscription",
    category: "coding",
    description:
      "Browser login for your Claude plan. Powers coding agents and workflows.",
    eligibility: ["code-agent", "requires browser login"],
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex subscription",
    category: "coding",
    description: "Browser or device login for Codex coding agents.",
    eligibility: ["code-agent", "requires browser login"],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI subscription",
    category: "coding",
    description:
      "Managed by Gemini CLI outside this app; orchestrated spawning is not wired yet.",
    eligibility: ["external CLI", "spawn unavailable"],
  },
  {
    id: "zai-coding",
    name: "z.ai Coding Plan",
    category: "coding",
    description:
      "Dedicated coding-endpoint credential; no coding-agent spawn backend is wired yet.",
    eligibility: ["model inference", "spawn unavailable"],
  },
  {
    id: "kimi-coding",
    name: "Kimi Code",
    category: "coding",
    description:
      "Dedicated Kimi coding-endpoint credential; no coding-agent spawn backend is wired yet.",
    eligibility: ["model inference", "spawn unavailable"],
  },
  {
    id: "deepseek-coding",
    name: "DeepSeek coding subscription",
    category: "coding",
    description: "No safe first-party subscription flow is available yet.",
    eligibility: ["code-agent", "unavailable"],
    unavailable: true,
  },
  {
    id: "anthropic-api",
    name: "Anthropic API",
    category: "chat",
    description: "Bring your own Anthropic API key for Claude chat models.",
    eligibility: ["chat", "API key"],
  },
  {
    id: "openai-api",
    name: "OpenAI API",
    category: "chat",
    description: "Bring your own OpenAI API key for GPT chat models.",
    eligibility: ["chat", "API key"],
  },
  {
    id: "cerebras-api",
    name: "Cerebras API",
    category: "chat",
    description: "Low-latency hosted inference with your Cerebras API key.",
    eligibility: ["chat", "API key"],
  },
  {
    id: "deepseek-api",
    name: "DeepSeek API",
    category: "chat",
    description:
      "Direct DeepSeek API billing for chat and OpenCode coding agents. This is API PAYG, not a consumer subscription.",
    eligibility: ["chat", "coding agent", "API key", "PAYG"],
  },
  {
    id: "zai-api",
    name: "z.ai API",
    category: "chat",
    description:
      "Direct z.ai general API billing for chat and OpenCode coding agents. The separate Coding Plan uses its dedicated endpoint key.",
    eligibility: ["chat", "coding agent", "API key", "PAYG"],
  },
  {
    id: "moonshot-api",
    name: "Kimi / Moonshot API",
    category: "chat",
    description:
      "Direct Moonshot API billing for chat and OpenCode coding agents. This does not use Kimi membership quota.",
    eligibility: ["chat", "coding agent", "API key", "PAYG"],
  },
  {
    id: "openrouter-api",
    name: "OpenRouter",
    category: "chat",
    description:
      "OpenRouter credits or BYOK routing with bounded model discovery.",
    eligibility: ["model inference", "coding agent", "API key"],
  },
  {
    id: "xai-api",
    name: "xAI API",
    category: "chat",
    description:
      "Metered xAI API access for Grok models; separate from Grok subscription login.",
    eligibility: ["model inference", "coding agent", "API key"],
  },
];

export function getAccountProviderOption(
  providerId: LinkedAccountProviderId,
): AccountProviderOption | undefined {
  return ACCOUNT_PROVIDER_OPTIONS.find((option) => option.id === providerId);
}
