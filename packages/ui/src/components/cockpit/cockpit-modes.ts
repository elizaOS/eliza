/**
 * Client-side cockpit mode descriptors and the lowering from a picked mode to
 * the orchestrator create-task body. This is the single source of truth for the
 * cockpit's mode → `providerPolicy` mapping (the UI library owns it; the picker
 * must not import a plugin).
 *
 * The three sanctioned modes:
 *   1. Eliza Cloud = eliza-code on Cerebras, fast/smart tier (gpt-oss-120b / zai-glm-4.7)
 *   2. OpenCode on Cerebras
 *   3. Claude / Codex via the TOS-safe subscription connector
 */

import type {
  CodingAgentCreateTaskInput,
  CodingAgentTaskProviderPolicy,
} from "../../api/client-types-cloud";

/** Eliza Cloud inference tiers. `small` is fast; `large` is smart. */
export type ElizaCloudTier = "small" | "large";

/** Canonical Cerebras model id per tier. */
export const ELIZA_CLOUD_TIER_MODEL: Record<ElizaCloudTier, string> = {
  small: "gpt-oss-120b",
  large: "zai-glm-4.7",
};

/** One cockpit session's mode. */
export type CockpitModeConfig =
  | { mode: "eliza-cloud"; agentType: "elizaos"; tier: ElizaCloudTier }
  | { mode: "opencode"; agentType: "opencode"; model?: string }
  | {
      mode: "subscription";
      agentType: "claude" | "codex";
      auth?: "subscription" | "api_keys";
      model?: string;
    };

/** Stable id for one selectable picker option (tier is chosen separately). */
export type CockpitModeOptionId =
  | "eliza-cloud"
  | "opencode"
  | "claude"
  | "codex";

/** Badge kind → drives the chip's accent styling. */
export type CockpitModeBadge = "cloud" | "sub";

/** A selectable option shown in the picker. */
export interface CockpitModeOption {
  id: CockpitModeOptionId;
  title: string;
  subtitle: string;
  badge: CockpitModeBadge;
  /** Build the concrete config for this option at the given Eliza Cloud tier
   * (tier is ignored by non-cloud options). */
  toConfig: (tier: ElizaCloudTier) => CockpitModeConfig;
}

/** The picker's options, in display order. */
export const COCKPIT_MODE_OPTIONS: readonly CockpitModeOption[] = [
  {
    id: "eliza-cloud",
    title: "Eliza Cloud",
    subtitle: "eliza-code · Cerebras",
    badge: "cloud",
    toConfig: (tier) => ({ mode: "eliza-cloud", agentType: "elizaos", tier }),
  },
  {
    id: "opencode",
    title: "OpenCode",
    subtitle: "Cerebras",
    badge: "cloud",
    toConfig: () => ({ mode: "opencode", agentType: "opencode" }),
  },
  {
    id: "claude",
    title: "Claude",
    subtitle: "Your subscription",
    badge: "sub",
    toConfig: () => ({ mode: "subscription", agentType: "claude" }),
  },
  {
    id: "codex",
    title: "Codex",
    subtitle: "Your subscription",
    badge: "sub",
    toConfig: () => ({ mode: "subscription", agentType: "codex" }),
  },
];

/** Map a concrete config back to the picker option id it represents. */
export function optionIdForConfig(
  config: CockpitModeConfig,
): CockpitModeOptionId {
  switch (config.mode) {
    case "eliza-cloud":
      return "eliza-cloud";
    case "opencode":
      return "opencode";
    case "subscription":
      return config.agentType;
  }
}

/** Read the Eliza Cloud tier from a config (defaults to `small` for non-cloud). */
export function tierForConfig(config: CockpitModeConfig): ElizaCloudTier {
  return config.mode === "eliza-cloud" ? config.tier : "small";
}

/** `providerSource` discriminant: where inference/credentials are sourced. */
export type ProviderSource =
  | "user-claude"
  | "user-openai"
  | "eliza-cloud"
  | "local";

/** The inference/credential source label for a mode. */
export function cockpitModeProviderSource(
  config: CockpitModeConfig,
): ProviderSource {
  switch (config.mode) {
    case "eliza-cloud":
    case "opencode":
      // Both run on Eliza Cloud / Cerebras.
      return "eliza-cloud";
    case "subscription":
      return config.agentType === "claude" ? "user-claude" : "user-openai";
  }
}

/** The model hint for a mode (undefined ⇒ let the host pick its default). */
export function cockpitModeModel(
  config: CockpitModeConfig,
): string | undefined {
  return config.mode === "eliza-cloud"
    ? ELIZA_CLOUD_TIER_MODEL[config.tier]
    : config.model;
}

/**
 * Lower a cockpit mode to the orchestrator's create-task `providerPolicy` —
 * the `{preferredFramework, providerSource, model}` the create-task route's
 * `asProviderPolicy` parser accepts.
 */
export function cockpitModeToProviderPolicy(
  config: CockpitModeConfig,
): CodingAgentTaskProviderPolicy {
  const policy: CodingAgentTaskProviderPolicy = {
    preferredFramework: config.agentType,
    providerSource: cockpitModeProviderSource(config),
  };
  const model = cockpitModeModel(config);
  if (model !== undefined) policy.model = model;
  return policy;
}

/** First non-empty line of `text`, trimmed to `max` chars — used as a task title. */
function deriveTitle(text: string, max = 80): string {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Build the orchestrator create-task input for a new cockpit session from a
 * free-text goal + the selected mode. `title` defaults to the goal's first line.
 */
export function buildCockpitCreateTaskInput(opts: {
  goal: string;
  mode: CockpitModeConfig;
  title?: string;
}): CodingAgentCreateTaskInput {
  const goal = opts.goal.trim();
  const title = (opts.title?.trim() || deriveTitle(goal)) ?? goal;
  return {
    title,
    goal,
    providerPolicy: cockpitModeToProviderPolicy(opts.mode),
  };
}
