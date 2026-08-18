/**
 * Shared types, constants, and fallback model lists for the Coding
 * Agent settings sub-components. Extracted out of
 * `CodingAgentSettingsSection.tsx` to keep that file under the
 * project's ~500 LOC guideline.
 */

export type AgentTab = "elizaos" | "pi-agent" | "claude" | "codex";
export type ApprovalPreset =
  | "readonly"
  | "standard"
  | "permissive"
  | "autonomous";
export type AgentSelectionStrategy = "fixed" | "ranked";
export type CodingAccountStrategy =
  | "priority"
  | "round-robin"
  | "least-used"
  | "quota-aware";
export type LlmProvider = "subscription" | "api_keys" | "cloud";

export const AGENT_TABS: AgentTab[] = [
  "elizaos",
  "pi-agent",
  "claude",
  "codex",
];

export const CODING_ACCOUNT_STRATEGIES: readonly CodingAccountStrategy[] = [
  "least-used",
  "round-robin",
  "priority",
  "quota-aware",
];

export const CODING_ACCOUNT_STRATEGY_OPTIONS: {
  value: CodingAccountStrategy;
  labelKey: string;
  defaultLabel: string;
}[] = [
  {
    value: "least-used",
    labelKey: "codingagentsettingssection.AccountStrategyLeastUsed",
    defaultLabel: "Least Used",
  },
  {
    value: "round-robin",
    labelKey: "codingagentsettingssection.AccountStrategyRoundRobin",
    defaultLabel: "Round Robin",
  },
  {
    value: "priority",
    labelKey: "codingagentsettingssection.AccountStrategyPriority",
    defaultLabel: "Priority",
  },
  {
    value: "quota-aware",
    labelKey: "codingagentsettingssection.AccountStrategyQuotaAware",
    defaultLabel: "Quota Aware",
  },
];

export function isCodingAccountStrategy(
  value: unknown,
): value is CodingAccountStrategy {
  return (
    typeof value === "string" &&
    CODING_ACCOUNT_STRATEGIES.includes(value as CodingAccountStrategy)
  );
}

export const APPROVAL_PRESETS: {
  value: ApprovalPreset;
  labelKey: string;
  descKey: string;
}[] = [
  {
    value: "readonly",
    labelKey: "codingagentsettingssection.PresetReadOnly",
    descKey: "codingagentsettingssection.PresetReadOnlyDesc",
  },
  {
    value: "standard",
    labelKey: "mediasettingssection.Standard",
    descKey: "codingagentsettingssection.PresetStandardDesc",
  },
  {
    value: "permissive",
    labelKey: "codingagentsettingssection.PresetPermissive",
    descKey: "codingagentsettingssection.PresetPermissiveDesc",
  },
  {
    value: "autonomous",
    labelKey: "codingagentsettingssection.PresetAutonomous",
    descKey: "codingagentsettingssection.PresetAutonomousDesc",
  },
];

export interface ModelOption {
  value: string;
  label: string;
}

export const AGENT_PROVIDER_MAP: Record<AgentTab, string> = {
  elizaos: "cerebras",
  "pi-agent": "cerebras",
  claude: "anthropic",
  codex: "openai",
};

export const FALLBACK_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { value: "o3", label: "o3" },
    { value: "o4-mini", label: "o4-mini" },
    { value: "gpt-4o", label: "GPT-4o" },
  ],
  cerebras: [{ value: "gemma-4-31b", label: "gemma-4-31b" }],
};

export const AGENT_LABELS: Record<AgentTab, string> = {
  elizaos: "elizaOS",
  "pi-agent": "Pi Agent",
  claude: "Claude",
  codex: "Codex",
};

/** Map full adapter names from the preflight API to short tab keys. */
export const ADAPTER_NAME_TO_TAB: Record<string, AgentTab> = {
  "claude code": "claude",
  eliza: "elizaos",
  "eliza os": "elizaos",
  elizaos: "elizaos",
  "eliza-code": "elizaos",
  opencode: "elizaos",
  "open code": "elizaos",
  "openai codex": "codex",
  pi: "pi-agent",
  "pi agent": "pi-agent",
  "pi-agent": "pi-agent",
  claude: "claude",
  codex: "codex",
};

const ELIZA_CODE_PROVIDER_KEYS = ["API_KEY", "BASE_URL", "LOCAL"] as const;

/** Loads settings with canonical eliza-code keys winning over legacy values. */
export function loadCodingAgentPrefs(
  env: Record<string, string>,
  cloud: Record<string, string>,
): Record<string, string> {
  const loaded: Record<string, string> = {};
  if (cloud.apiKey) loaded._CLOUD_API_KEY = cloud.apiKey;

  for (const agent of ["ELIZAOS", "CLAUDE", "CODEX"] as const) {
    const prefix = `ELIZA_${agent}`;
    for (const suffix of ["MODEL_POWERFUL", "MODEL_FAST"] as const) {
      const key = `${prefix}_${suffix}`;
      if (env[key]) loaded[key] = env[key];
    }
  }
  for (const key of [
    "ELIZA_DEFAULT_APPROVAL_PRESET",
    "ELIZA_AGENT_SELECTION_STRATEGY",
    "ELIZA_DEFAULT_AGENT_TYPE",
    "ELIZA_SCRATCH_RETENTION",
    "ELIZA_CODING_DIRECTORY",
    "ELIZA_LLM_PROVIDER",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
  ] as const) {
    if (env[key]) loaded[key] = env[key];
  }
  for (const suffix of ELIZA_CODE_PROVIDER_KEYS) {
    const canonicalKey = `ELIZA_CODE_${suffix}`;
    const legacyKey = `ELIZA_OPENCODE_${suffix}`;
    const value = env[canonicalKey] || env[legacyKey];
    if (value) loaded[canonicalKey] = value;
  }
  return loaded;
}

export const ENV_PREFIX: Record<AgentTab, string> = {
  elizaos: "ELIZA_ELIZAOS",
  "pi-agent": "ELIZA_PI_AGENT",
  claude: "ELIZA_CLAUDE",
  codex: "ELIZA_CODEX",
};

export interface AuthResult {
  agent: AgentTab;
  launched?: boolean;
  url?: string;
  deviceCode?: string;
  instructions: string;
}
