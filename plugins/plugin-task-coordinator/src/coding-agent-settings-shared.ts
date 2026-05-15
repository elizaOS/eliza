/**
 * Shared types, constants, and fallback model lists for the Coding
 * Agent settings sub-components. Extracted out of
 * `CodingAgentSettingsSection.tsx` to keep that file under the
 * project's ~500 LOC guideline.
 */

export type AgentTab = "claude" | "codex" | "opencode";
export type ApprovalPreset =
  | "readonly"
  | "standard"
  | "permissive"
  | "autonomous";
export type AgentSelectionStrategy = "fixed" | "ranked";
export type LlmProvider = "subscription" | "api_keys" | "cloud";

export const AGENT_TABS: AgentTab[] = ["claude", "codex", "opencode"];

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
  claude: "anthropic",
  codex: "openai",
  opencode: "openai",
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
};

export const AGENT_LABELS: Record<AgentTab, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

/** Map full adapter names from the preflight API to short tab keys. */
export const ADAPTER_NAME_TO_TAB: Record<string, AgentTab> = {
  "claude code": "claude",
  "openai codex": "codex",
  "open code": "opencode",
  opencode: "opencode",
  claude: "claude",
  codex: "codex",
};

export const ENV_PREFIX: Record<AgentTab, string> = {
  claude: "ELIZA_CLAUDE",
  codex: "ELIZA_CODEX",
  opencode: "ELIZA_OPENCODE",
};

export interface AuthResult {
  agent: AgentTab;
  launched?: boolean;
  url?: string;
  deviceCode?: string;
  instructions: string;
}
