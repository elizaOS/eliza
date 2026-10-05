/**
 * Static provider metadata shared by account enrollment, provider rows, and
 * capability display. Keeping the catalog outside the dialog prevents
 * presentational components from depending on the enrollment state machine.
 */
import type { LinkedAccountProviderId } from "@elizaos/host/protocol";
export type AccountProviderCategory = "chat" | "coding" | "local" | "cloud";
export interface AccountProviderOption {
  id: LinkedAccountProviderId;
  name: string;
  labelKey: string;
  category: AccountProviderCategory;
  description: string;
  eligibility: string[];
  unavailable?: boolean;
}
export const ACCOUNT_PROVIDER_OPTIONS: AccountProviderOption[] = [
  {
    id: "anthropic-subscription",
    labelKey: "accounts.provider.anthropicSubscription",
    name: "Claude subscription",
    category: "coding",
    description:
      "Browser login for your Claude plan. Powers coding agents and workflows.",
    eligibility: ["code-agent", "requires browser login"],
  },
  {
    id: "openai-codex",
    labelKey: "accounts.provider.openaiCodex",
    name: "OpenAI Codex subscription",
    category: "coding",
    description: "Browser or device login for Codex coding agents.",
    eligibility: ["code-agent", "requires browser login"],
  },
  {
    id: "gemini-cli",
    labelKey: "accounts.provider.geminiCli",
    name: "Gemini CLI subscription",
    category: "coding",
    description:
      "Managed by Gemini CLI outside this app; orchestrated spawning is not wired yet.",
    eligibility: ["external CLI", "spawn unavailable"],
  },
  {
    id: "zai-coding",
    labelKey: "accounts.provider.zaiCoding",
    name: "z.ai Coding Plan",
    category: "coding",
    description:
      "Dedicated coding-endpoint credential; no coding-agent spawn backend is wired yet.",
    eligibility: ["model inference", "spawn unavailable"],
  },
  {
    id: "kimi-coding",
    labelKey: "accounts.provider.kimiCoding",
    name: "Kimi Coding Endpoint Key",
    category: "coding",
    description:
      "Dedicated coding-endpoint key for model inference. Kimi ACP uses a separate kimi login OAuth session and never receives this key.",
    eligibility: ["model inference", "endpoint key", "not ACP login"],
  },
  {
    id: "deepseek-coding",
    labelKey: "accounts.provider.deepseekCoding",
    name: "DeepSeek coding subscription",
    category: "coding",
    description: "No safe first-party subscription flow is available yet.",
    eligibility: ["code-agent", "unavailable"],
    unavailable: true,
  },
  {
    id: "anthropic-api",
    labelKey: "accounts.provider.anthropicApi",
    name: "Anthropic API",
    category: "chat",
    description: "Bring your own Anthropic API key for Claude chat models.",
    eligibility: ["chat", "API key"],
  },
  {
    id: "openai-api",
    labelKey: "accounts.provider.openaiApi",
    name: "OpenAI API",
    category: "chat",
    description: "Bring your own OpenAI API key for GPT chat models.",
    eligibility: ["chat", "API key"],
  },
  {
    id: "cerebras-api",
    labelKey: "accounts.provider.cerebrasApi",
    name: "Cerebras API",
    category: "chat",
    description: "Low-latency hosted inference with your Cerebras API key.",
    eligibility: ["chat", "API key"],
  },
  {
    id: "deepseek-api",
    labelKey: "accounts.provider.deepseekApi",
    name: "DeepSeek API",
    category: "chat",
    description:
      "Direct DeepSeek API billing for model inference; coding-agent spawning is not wired yet.",
    eligibility: ["chat", "API key"],
  },
  {
    id: "zai-api",
    labelKey: "accounts.provider.zaiApi",
    name: "z.ai API",
    category: "chat",
    description: "Direct z.ai API key for model routing.",
    eligibility: ["chat", "API key"],
  },
  {
    id: "moonshot-api",
    labelKey: "accounts.provider.moonshotApi",
    name: "Kimi / Moonshot API",
    category: "chat",
    description: "Direct Moonshot API key for Kimi models.",
    eligibility: ["chat", "API key"],
  },
  {
    id: "openrouter-api",
    labelKey: "accounts.provider.openrouterApi",
    name: "OpenRouter",
    category: "chat",
    description:
      "OpenRouter credits or BYOK for model inference and coding agents. Choose a model when starting a coding agent.",
    eligibility: ["model inference", "code-agent", "API key"],
  },
  {
    id: "xai-api",
    labelKey: "accounts.provider.xaiApi",
    name: "xAI API",
    category: "chat",
    description:
      "Metered xAI API access for Grok model inference and coding agents; separate from Grok subscription login.",
    eligibility: ["model inference", "code-agent", "API key"],
  },
];
export function getAccountProviderOption(
  providerId: LinkedAccountProviderId,
): AccountProviderOption | undefined {
  return ACCOUNT_PROVIDER_OPTIONS.find((option) => option.id === providerId);
}

export function accountProviderDisplayName(
  providerId: LinkedAccountProviderId,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  const option = getAccountProviderOption(providerId);
  return option
    ? t(option.labelKey, { defaultValue: option.name })
    : providerId;
}
