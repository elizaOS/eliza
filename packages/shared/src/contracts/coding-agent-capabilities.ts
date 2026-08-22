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

export const CODING_PROVIDER_DESCRIPTOR_VERSION = 1 as const;

export type CodingProviderAccountKind = "subscription" | "api-key";
export type CodingProviderAuthMode =
  | "oauth"
  | "direct-api-key"
  | "coding-plan-key"
  | "external-cli"
  | "unavailable";
export type CodingProviderBillingMode =
  | "subscription-coding-plan"
  | "subscription-coding-cli"
  | "usage";
export type CodingProviderSubscriptionAuthMode =
  | "oauth"
  | "external-cli"
  | "coding-plan-key"
  | "unavailable";
export type CodingProviderSubscriptionBillingMode =
  | "subscription-coding-plan"
  | "subscription-coding-cli";
export type CodingProviderDiscoveryPolicy =
  | "bundled-or-configured-command"
  | "configured-command-or-path"
  | "vendored-or-path"
  | "none";

interface CodingAgentBackendPreflightBase {
  requiredRuntime: string;
  discoveryPolicy: Exclude<CodingProviderDiscoveryPolicy, "none">;
  commandConfigKey: string;
}

export type CodingAgentBackendPreflight = CodingAgentBackendPreflightBase &
  (
    | { commandResolution: "literal"; defaultCommand: string }
    | { commandResolution: "managed-codex" }
    | { commandResolution: "vendored-opencode"; defaultCommand: string }
  );

/** Executable discovery contract implemented by ACP for every spawn backend. */
export const CODING_AGENT_BACKEND_PREFLIGHTS = {
  elizaos: {
    requiredRuntime: "eliza-code-acp",
    discoveryPolicy: "bundled-or-configured-command",
    commandConfigKey: "ELIZA_ELIZAOS_ACP_COMMAND",
    commandResolution: "literal",
    defaultCommand: "eliza-code-acp",
  },
  "pi-agent": {
    requiredRuntime: "pi-agent",
    discoveryPolicy: "bundled-or-configured-command",
    commandConfigKey: "ELIZA_PI_AGENT_ACP_COMMAND",
    commandResolution: "literal",
    defaultCommand: "pi-agent",
  },
  claude: {
    requiredRuntime: "claude-acp",
    discoveryPolicy: "configured-command-or-path",
    commandConfigKey: "ELIZA_CLAUDE_ACP_COMMAND",
    commandResolution: "literal",
    defaultCommand: "npx -y @agentclientprotocol/claude-agent-acp@0.34.0",
  },
  codex: {
    requiredRuntime: "codex-acp",
    discoveryPolicy: "configured-command-or-path",
    commandConfigKey: "ELIZA_CODEX_ACP_COMMAND",
    commandResolution: "managed-codex",
  },
  opencode: {
    requiredRuntime: "opencode-acp",
    discoveryPolicy: "vendored-or-path",
    commandConfigKey: "ELIZA_OPENCODE_ACP_COMMAND",
    commandResolution: "vendored-opencode",
    defaultCommand: "opencode acp",
  },
} as const satisfies Readonly<
  Record<CodingAgentBackend, CodingAgentBackendPreflight>
>;

export interface CodingProviderDescriptor {
  version: typeof CODING_PROVIDER_DESCRIPTOR_VERSION;
  providerId: string;
  accountKind: CodingProviderAccountKind;
  authMode: CodingProviderAuthMode;
  billingMode: CodingProviderBillingMode;
  inferenceSupport: boolean;
  backend: CodingAgentBackend | null;
  spawnSupport: boolean;
  requiredRuntime: string | null;
  discoveryPolicy: CodingProviderDiscoveryPolicy;
  unsupportedReason: string | null;
}

export function isCodingAgentBackend(
  value: unknown,
): value is CodingAgentBackend {
  return (
    typeof value === "string" &&
    CODING_AGENT_BACKENDS.includes(value as CodingAgentBackend)
  );
}

function descriptor<
  const ProviderId extends string,
  const AccountKind extends CodingProviderAccountKind,
  const AuthMode extends CodingProviderAuthMode,
  const BillingMode extends CodingProviderBillingMode,
  const InferenceSupport extends boolean,
  const Backend extends CodingAgentBackend | null,
>(
  providerId: ProviderId,
  accountKind: AccountKind,
  authMode: AuthMode,
  billingMode: BillingMode,
  inferenceSupport: InferenceSupport,
  backend: Backend,
  unsupportedReason: string | null,
): CodingProviderDescriptor & {
  providerId: ProviderId;
  accountKind: AccountKind;
  authMode: AuthMode;
  billingMode: BillingMode;
  inferenceSupport: InferenceSupport;
  backend: Backend;
} {
  const preflight = backend ? CODING_AGENT_BACKEND_PREFLIGHTS[backend] : null;
  return {
    version: CODING_PROVIDER_DESCRIPTOR_VERSION,
    providerId,
    accountKind,
    authMode,
    billingMode,
    inferenceSupport,
    backend,
    spawnSupport: backend !== null,
    requiredRuntime: preflight?.requiredRuntime ?? null,
    discoveryPolicy: preflight?.discoveryPolicy ?? "none",
    unsupportedReason,
  };
}

/**
 * Canonical account, inference, and executable-spawn truth for every linked
 * account provider in the runtime catalog.
 */
export const CODING_PROVIDER_DESCRIPTORS = {
  "anthropic-subscription": descriptor(
    "anthropic-subscription",
    "subscription",
    "oauth",
    "subscription-coding-cli",
    false,
    "claude",
    null,
  ),
  "openai-codex": descriptor(
    "openai-codex",
    "subscription",
    "oauth",
    "subscription-coding-cli",
    true,
    "codex",
    null,
  ),
  "gemini-cli": descriptor(
    "gemini-cli",
    "subscription",
    "external-cli",
    "subscription-coding-cli",
    false,
    null,
    "Gemini CLI is not wired to a supported coding-agent spawn backend.",
  ),
  "zai-coding": descriptor(
    "zai-coding",
    "subscription",
    "coding-plan-key",
    "subscription-coding-plan",
    true,
    null,
    "The z.ai coding credential can serve model inference, but no supported coding-agent spawn backend consumes it.",
  ),
  "kimi-coding": descriptor(
    "kimi-coding",
    "subscription",
    "coding-plan-key",
    "subscription-coding-plan",
    true,
    null,
    "The Kimi coding credential can serve model inference, but no supported coding-agent spawn backend consumes it.",
  ),
  "deepseek-coding": descriptor(
    "deepseek-coding",
    "subscription",
    "unavailable",
    "subscription-coding-plan",
    false,
    null,
    "No first-party DeepSeek coding subscription surface or supported coding-agent spawn backend is available.",
  ),
  "anthropic-api": descriptor(
    "anthropic-api",
    "api-key",
    "direct-api-key",
    "usage",
    true,
    "claude",
    null,
  ),
  "openai-api": descriptor(
    "openai-api",
    "api-key",
    "direct-api-key",
    "usage",
    true,
    "codex",
    null,
  ),
  "deepseek-api": descriptor(
    "deepseek-api",
    "api-key",
    "direct-api-key",
    "usage",
    true,
    "opencode",
    null,
  ),
  "zai-api": descriptor(
    "zai-api",
    "api-key",
    "direct-api-key",
    "usage",
    true,
    "opencode",
    null,
  ),
  "moonshot-api": descriptor(
    "moonshot-api",
    "api-key",
    "direct-api-key",
    "usage",
    true,
    "opencode",
    null,
  ),
  "cerebras-api": descriptor(
    "cerebras-api",
    "api-key",
    "direct-api-key",
    "usage",
    true,
    "opencode",
    null,
  ),
} as const satisfies Readonly<Record<string, CodingProviderDescriptor>>;

export type CodingProviderId = keyof typeof CODING_PROVIDER_DESCRIPTORS;

/** Ordered credential providers derived from the canonical descriptors. */
export const CODING_AGENT_BACKEND_PROVIDERS = Object.fromEntries(
  CODING_AGENT_BACKENDS.map((backend) => [
    backend,
    Object.values(CODING_PROVIDER_DESCRIPTORS)
      .filter((descriptor) => descriptor.backend === backend)
      .map((descriptor) => descriptor.providerId as CodingProviderId),
  ]),
) as unknown as Readonly<
  Record<CodingAgentBackend, readonly CodingProviderId[]>
>;

export type CodingAgentAccountProviderId =
  (typeof CODING_AGENT_BACKEND_PROVIDERS)[CodingAgentBackend][number];

export interface CodingProviderSupportMatrix {
  version: typeof CODING_PROVIDER_DESCRIPTOR_VERSION;
  providers: readonly CodingProviderDescriptor[];
}

/** Serializable domain artifact used by reviews and catalog drift checks. */
export const CODING_PROVIDER_SUPPORT_MATRIX: CodingProviderSupportMatrix = {
  version: CODING_PROVIDER_DESCRIPTOR_VERSION,
  providers: Object.values(CODING_PROVIDER_DESCRIPTORS),
};

export function codingProviderDescriptorForProvider(
  providerId: string,
): CodingProviderDescriptor | undefined {
  return CODING_PROVIDER_DESCRIPTORS[providerId as CodingProviderId];
}

export type CodingSubscriptionProviderId = {
  [ProviderId in CodingProviderId]: (typeof CODING_PROVIDER_DESCRIPTORS)[ProviderId]["accountKind"] extends "subscription"
    ? ProviderId
    : never;
}[CodingProviderId];

export function isCodingSubscriptionProvider(
  providerId: string,
): providerId is CodingSubscriptionProviderId {
  return (
    codingProviderDescriptorForProvider(providerId)?.accountKind ===
    "subscription"
  );
}

/** Maps a subscription descriptor to the auth package's enrollment contract. */
export function codingProviderSubscriptionAuthMode(
  providerId: CodingSubscriptionProviderId,
): CodingProviderSubscriptionAuthMode {
  const descriptor = CODING_PROVIDER_DESCRIPTORS[providerId];
  switch (descriptor.authMode) {
    case "oauth":
      return "oauth";
    case "external-cli":
      return "external-cli";
    case "coding-plan-key":
      return "coding-plan-key";
    case "unavailable":
      return "unavailable";
  }
}

/** Maps canonical billing truth to the subscription-status wire vocabulary. */
export function codingProviderSubscriptionBillingMode(
  providerId: CodingSubscriptionProviderId,
): CodingProviderSubscriptionBillingMode {
  const descriptor = CODING_PROVIDER_DESCRIPTORS[providerId];
  return descriptor.billingMode;
}

export interface CodingAgentSpawnCapability {
  available: boolean;
  backend?: CodingAgentBackend;
  unavailableReason?: string;
}

/** Resolve the executable backend that can consume a linked account. */
export function codingAgentBackendForProvider(
  providerId: string,
): CodingAgentBackend | undefined {
  return codingProviderDescriptorForProvider(providerId)?.backend ?? undefined;
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
  const descriptor = codingProviderDescriptorForProvider(providerId);
  return {
    available: false,
    unavailableReason:
      descriptor?.unsupportedReason ??
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

export type ProviderCredentialPath = Exclude<
  NonNullable<ProviderRuntimeCapability["credentialPath"]>,
  "none"
>;

/** Resolve where runtime consumers may obtain a linked provider credential. */
export function codingProviderCredentialPathForProvider(
  providerId: string,
): ProviderCredentialPath | undefined {
  const descriptor = codingProviderDescriptorForProvider(providerId);
  if (!descriptor) return undefined;
  if (descriptor.authMode === "external-cli") return "external-cli";
  return descriptor.accountKind === "api-key" ? "direct-api" : "account-pool";
}

export interface ProviderRuntimeEligibility {
  chat: ProviderRuntimeCapability;
  codingAgent: ProviderRuntimeCapability;
}
