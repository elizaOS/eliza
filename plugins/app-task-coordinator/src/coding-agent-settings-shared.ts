/**
 * Shared types, constants, and fallback model lists for the Coding
 * Agent settings sub-components. Extracted out of
 * `CodingAgentSettingsSection.tsx` to keep that file under the
 * project's ~500 LOC guideline.
 */

export type AgentTab = "claude" | "gemini" | "codex" | "aider";
export type AiderProvider = "anthropic" | "openai" | "google";
export type ApprovalPreset =
  | "readonly"
  | "standard"
  | "permissive"
  | "autonomous";
export type AgentSelectionStrategy = "fixed" | "ranked";
export type LlmProvider = "subscription" | "api_keys" | "cloud";

export const AGENT_TABS: AgentTab[] = ["claude", "gemini", "codex", "aider"];

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
  gemini: "google-genai",
  codex: "openai",
  aider: "anthropic",
};

export const AIDER_PROVIDER_MAP: Record<AiderProvider, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google-genai",
};

export const FALLBACK_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  "google-genai": [
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
  openai: [
    { value: "o3", label: "o3" },
    { value: "o4-mini", label: "o4-mini" },
    { value: "gpt-4o", label: "GPT-4o" },
  ],
};

/** Aider uses short aliases that auto-resolve to the latest model version. */
export const AIDER_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { value: "opus", label: "Claude Opus" },
    { value: "sonnet", label: "Claude Sonnet" },
    { value: "haiku", label: "Claude Haiku" },
  ],
  "google-genai": [{ value: "gemini", label: "Gemini" }],
  openai: [
    { value: "o3", label: "o3" },
    { value: "4o", label: "GPT-4o" },
    { value: "o4-mini", label: "o4-mini" },
  ],
};

export const AGENT_LABELS: Record<AgentTab, string> = {
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
  aider: "Aider",
};

/** Map full adapter names from the preflight API to short tab keys. */
export const ADAPTER_NAME_TO_TAB: Record<string, AgentTab> = {
  "claude code": "claude",
  "google gemini": "gemini",
  "openai codex": "codex",
  aider: "aider",
  claude: "claude",
  gemini: "gemini",
  codex: "codex",
};

export const ENV_PREFIX: Record<AgentTab, string> = {
  claude: "PARALLAX_CLAUDE",
  gemini: "PARALLAX_GEMINI",
  codex: "PARALLAX_CODEX",
  aider: "PARALLAX_AIDER",
};

export interface AuthResult {
  agent: AgentTab;
  launched?: boolean;
  url?: string;
  deviceCode?: string;
  instructions: string;
}
