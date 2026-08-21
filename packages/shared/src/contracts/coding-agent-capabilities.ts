/**
 * Defines the coding-agent backends that can actually be spawned and the
 * linked-account providers whose credentials those backends consume.
 * Enrollment and model inference remain separate capabilities: a provider
 * absent from this map must never be advertised as coding-agent spawnable.
 */

export const CODING_AGENT_BACKENDS = [
  "elizaos",
  "pi-agent",
  "claude",
  "codex",
  "opencode",
] as const;

export type CodingAgentBackend = (typeof CODING_AGENT_BACKENDS)[number];

export function isCodingAgentBackend(
  value: unknown,
): value is CodingAgentBackend {
  return (
    typeof value === "string" &&
    CODING_AGENT_BACKENDS.includes(value as CodingAgentBackend)
  );
}

/** Ordered credential providers per executable backend. */
export const CODING_AGENT_BACKEND_PROVIDERS = {
  elizaos: [],
  "pi-agent": [],
  claude: ["anthropic-subscription", "anthropic-api"],
  codex: ["openai-codex", "openai-api"],
  opencode: ["cerebras-api"],
} as const satisfies Readonly<Record<CodingAgentBackend, readonly string[]>>;

export type CodingAgentAccountProviderId =
  (typeof CODING_AGENT_BACKEND_PROVIDERS)[CodingAgentBackend][number];

const PROVIDER_BACKENDS: Readonly<Partial<Record<string, CodingAgentBackend>>> =
  Object.fromEntries(
    Object.entries(CODING_AGENT_BACKEND_PROVIDERS).flatMap(
      ([backend, providers]) =>
        providers.map((providerId) => [providerId, backend]),
    ),
  ) as Partial<Record<string, CodingAgentBackend>>;

const PROVIDER_UNAVAILABLE_REASONS: Readonly<Partial<Record<string, string>>> =
  {
    "gemini-cli":
      "Gemini CLI is not wired to a supported coding-agent spawn backend.",
    "zai-coding":
      "The z.ai coding credential can serve model inference, but no supported coding-agent spawn backend consumes it.",
    "kimi-coding":
      "The Kimi coding credential can serve model inference, but no supported coding-agent spawn backend consumes it.",
    "deepseek-coding":
      "No first-party DeepSeek coding subscription surface or supported coding-agent spawn backend is available.",
    "deepseek-api":
      "The DeepSeek API account can serve model inference, but no supported coding-agent spawn backend consumes it.",
    "zai-api":
      "The z.ai API account can serve model inference, but no supported coding-agent spawn backend consumes it.",
    "moonshot-api":
      "The Kimi / Moonshot API account can serve model inference, but no supported coding-agent spawn backend consumes it.",
  };

export interface CodingAgentSpawnCapability {
  available: boolean;
  backend?: CodingAgentBackend;
  unavailableReason?: string;
}

/** Resolve the executable backend that can consume a linked account. */
export function codingAgentBackendForProvider(
  providerId: string,
): CodingAgentBackend | undefined {
  return PROVIDER_BACKENDS[providerId];
}

/**
 * Return the account-to-spawn routing verdict. This describes implemented
 * routing only; host/device executable readiness is reported by ACP preflight.
 */
export function codingAgentSpawnCapabilityForProvider(
  providerId: string,
): CodingAgentSpawnCapability {
  const backend = codingAgentBackendForProvider(providerId);
  if (backend) return { available: true, backend };
  return {
    available: false,
    unavailableReason:
      PROVIDER_UNAVAILABLE_REASONS[providerId] ??
      "No supported coding-agent spawn backend consumes this account provider.",
  };
}

export interface ProviderRuntimeCapability {
  available: boolean;
  defaultModel?: string;
  credentialPath?: "account-pool" | "direct-api" | "external-cli" | "none";
  backend?: CodingAgentBackend;
  unavailableReason?: string;
}

export interface ProviderRuntimeEligibility {
  chat: ProviderRuntimeCapability;
  codingAgent: ProviderRuntimeCapability;
}
