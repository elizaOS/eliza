/**
 * Client-side cockpit mode descriptors — the app-facing mirror of the
 * orchestrator's canonical `cockpit-mode.ts`
 * (`plugins/plugin-agent-orchestrator/src/services/cockpit-mode.ts`).
 *
 * The picker lives in the UI library and must not import a plugin, so the mode
 * *shape* is mirrored here (it is an interface contract, not logic) and the
 * display metadata that drives the picker lives here as its source of truth.
 * The app layer lowers a {@link CockpitModeConfig} to the orchestrator
 * create-task body (`providerPolicy`) — the canonical lowering is the plugin's
 * `cockpitModeToProviderPolicy`.
 *
 * The four modes (locked product vision):
 *   1. Eliza Cloud = eliza-code on Cerebras, fast/smart tier (gpt-oss-120b / zai-glm-4.7)
 *   2. OpenCode on Cerebras
 *   3. Claude / Codex via the TOS-safe subscription connector
 *   4. Experimental TOS-unsafe Claude / Codex (gated)
 */

import type {
  CodingAgentCreateTaskInput,
  CodingAgentTaskProviderPolicy,
} from "../../api/client-types-cloud";

/** Eliza Cloud inference tiers. `small` is fast; `large` is smart. */
export type ElizaCloudTier = "small" | "large";

/** Canonical Cerebras model id per tier (mirrors the plugin's source of truth). */
export const ELIZA_CLOUD_TIER_MODEL: Record<ElizaCloudTier, string> = {
  small: "gpt-oss-120b",
  large: "zai-glm-4.7",
};

/** One cockpit session's mode (shape-mirror of the orchestrator's union). */
export type CockpitModeConfig =
  | { mode: "eliza-cloud"; agentType: "elizaos"; tier: ElizaCloudTier }
  | { mode: "opencode"; agentType: "opencode"; model?: string }
  | {
      mode: "subscription";
      agentType: "claude" | "codex";
      auth?: "subscription" | "api_keys";
      model?: string;
    }
  | {
      mode: "experimental";
      agentType: "claude" | "codex";
      proxy: "anthropic-proxy" | "codex-cli";
      model?: string;
    };

/** Stable id for one selectable picker option (tier is chosen separately). */
export type CockpitModeOptionId =
  | "eliza-cloud"
  | "opencode"
  | "claude"
  | "codex"
  | "claude-experimental"
  | "codex-experimental";

/** Badge kind → drives the chip's accent styling. */
export type CockpitModeBadge = "cloud" | "sub" | "exp";

/** A selectable option shown in the picker. */
export interface CockpitModeOption {
  id: CockpitModeOptionId;
  title: string;
  subtitle: string;
  badge: CockpitModeBadge;
  /** TOS-unsafe — only shown when the experimental gate is armed. */
  experimental?: boolean;
  /** Build the concrete config for this option at the given Eliza Cloud tier
   * (tier is ignored by non-cloud options). */
  toConfig: (tier: ElizaCloudTier) => CockpitModeConfig;
}

/** The picker's options, in display order. Experimental ones are gated. */
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
  {
    id: "claude-experimental",
    title: "Claude",
    subtitle: "Replay proxy · TOS-unsafe",
    badge: "exp",
    experimental: true,
    toConfig: () => ({
      mode: "experimental",
      agentType: "claude",
      proxy: "anthropic-proxy",
    }),
  },
  {
    id: "codex-experimental",
    title: "Codex",
    subtitle: "Replay proxy · TOS-unsafe",
    badge: "exp",
    experimental: true,
    toConfig: () => ({
      mode: "experimental",
      agentType: "codex",
      proxy: "codex-cli",
    }),
  },
];

/** The picker options visible given whether the experimental gate is armed. */
export function visibleCockpitModeOptions(
  experimentalEnabled: boolean,
): CockpitModeOption[] {
  return COCKPIT_MODE_OPTIONS.filter(
    (o) => experimentalEnabled || !o.experimental,
  );
}

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
    case "experimental":
      return config.agentType === "claude"
        ? "claude-experimental"
        : "codex-experimental";
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

/** The inference/credential source label for a mode (mirrors the orchestrator
 * canonical `cockpit-mode.ts`). */
export function cockpitModeProviderSource(
  config: CockpitModeConfig,
): ProviderSource {
  switch (config.mode) {
    case "eliza-cloud":
    case "opencode":
      // Both run on Eliza Cloud / Cerebras.
      return "eliza-cloud";
    case "subscription":
    case "experimental":
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
 * Lower a cockpit mode to the orchestrator's create-task `providerPolicy`.
 * The server-canonical lowering is the plugin's `cockpitModeToProviderPolicy`;
 * this client mirror produces the identical `{preferredFramework, providerSource,
 * model}` the create-task route's `asProviderPolicy` parser accepts.
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
