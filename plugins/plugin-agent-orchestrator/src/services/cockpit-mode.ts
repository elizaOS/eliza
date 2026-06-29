/**
 * Cockpit mode configuration — the single per-session "mode" the Eliza Coding
 * Cockpit exposes, and the pure mapping that lowers it onto the *real*
 * orchestrator levers.
 *
 * The cockpit replaces a developer's many-terminals workflow (Claude Code CLI,
 * Codex CLI, eliza-code, opencode, Eliza Cloud) with one mobile-first view. A
 * "mode" is what you pick when you spawn — or drop into — a single session. The
 * four locked modes are:
 *
 *   1. `eliza-cloud`  — "Eliza Cloud" = eliza-code (`elizaos`) running on
 *                       Eliza Cloud / Cerebras, with a fast/smart tier:
 *                       `small` = gpt-oss-120b, `large` = zai-glm-4.7.
 *   2. `opencode`     — OpenCode running on Cerebras (sibling cloud option).
 *   3. `subscription` — Claude / Codex via the TOS-safe subscription connector
 *                       (subscription preferred, API-key fallback — handled by
 *                       the account bridge; see `ORCHESTRATOR_BACKEND_AUTH`).
 *   4. `experimental` — Claude / Codex via the TOS-unsafe replay proxies. Typed
 *                       here for completeness; enabling the proxy is a separate,
 *                       explicitly-gated concern (env/credential injection) and
 *                       is intentionally NOT performed by this pure module.
 *
 * This module is **pure** (no I/O, no runtime imports) so it is unit-testable
 * and safe to share between the plugin (node) and the app (browser, via the
 * client facade). It lowers a {@link CockpitModeConfig} to:
 *
 *   - {@link TaskProviderPolicy} (the durable create path,
 *     `POST /api/orchestrator/tasks`), and
 *   - the `agentType`/`model` subset of {@link SpawnOptions} (the direct ACP
 *     spawn path, `POST /api/coding-agents`).
 *
 * The lowering targets are exactly what `OrchestratorTaskService.spawnSession`
 * consumes: `agentType = framework ?? policy.preferredFramework ?? default`,
 * `model = opts.model ?? policy.model`, and `providerSource` carried on the
 * session for display/accounting.
 *
 * @module services/cockpit-mode
 */
import type { AgentType, SpawnOptions } from "./types.js";
import type { TaskProviderPolicy } from "./orchestrator-task-types.js";

/** The four cockpit mode kinds (the discriminant of {@link CockpitModeConfig}). */
export type CockpitModeKind =
  | "eliza-cloud"
  | "opencode"
  | "subscription"
  | "experimental";

/** Eliza Cloud inference tiers. `small` is the fast model; `large` is the smart model. */
export type ElizaCloudTier = "small" | "large";

/**
 * Canonical Cerebras model id per Eliza Cloud tier. `small` → gpt-oss-120b
 * (fast), `large` → zai-glm-4.7 (smart). Kept here as the single source of
 * truth so the picker label and the spawned model never drift. (The `large`
 * pin must exist in `FALLBACK_MODELS.cerebras` for cloud routing — see the
 * cloud-model-toggle seam in the implementation plan.)
 */
export const ELIZA_CLOUD_TIER_MODEL: Record<ElizaCloudTier, string> = {
  small: "gpt-oss-120b",
  large: "zai-glm-4.7",
};

/** The subscription-backed coding frameworks selectable in the cockpit. */
export type SubscriptionFramework = Extract<AgentType, "claude" | "codex">;

/** The TOS-unsafe replay proxy a given experimental framework runs through. */
export type ExperimentalProxy = "anthropic-proxy" | "codex-cli";

/**
 * One cockpit session's mode. A discriminated union over the four real levers:
 * which framework spawns, which inference source/model backs it, and (for the
 * gated experimental modes) which replay proxy it would use.
 */
export type CockpitModeConfig =
  | { mode: "eliza-cloud"; agentType: "elizaos"; tier: ElizaCloudTier }
  | { mode: "opencode"; agentType: "opencode"; model?: string }
  | {
      mode: "subscription";
      agentType: SubscriptionFramework;
      /** Connector auth hint. The account bridge prefers subscription and falls
       * back to API key automatically; this only records the user's intent. */
      auth?: "subscription" | "api_keys";
      model?: string;
    }
  | {
      mode: "experimental";
      agentType: SubscriptionFramework;
      proxy: ExperimentalProxy;
      model?: string;
    };

/**
 * `TaskProviderPolicy.providerSource` discriminant: where inference/credentials
 * come from. Mirrors the values the orchestrator route + mapper understand.
 */
export type ProviderSource = "user-claude" | "user-openai" | "eliza-cloud" | "local";

/** Resolve the inference/credential source label for a mode. */
function providerSourceFor(config: CockpitModeConfig): ProviderSource {
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

/** Resolve the model hint for a mode (undefined ⇒ let the host pick its default). */
function modelFor(config: CockpitModeConfig): string | undefined {
  return config.mode === "eliza-cloud"
    ? ELIZA_CLOUD_TIER_MODEL[config.tier]
    : config.model;
}

/**
 * Lower a cockpit mode to a {@link TaskProviderPolicy} for the durable create
 * path. Note: the policy is intentionally agnostic about the
 * subscription-vs-API-key choice — the account bridge resolves that by
 * framework (subscription preferred). Experimental modes lower to the same
 * policy as their subscription counterpart; enabling the replay proxy is a
 * separate gated step (see {@link cockpitModeRequiresExperimentalGate}).
 */
export function cockpitModeToProviderPolicy(
  config: CockpitModeConfig,
): TaskProviderPolicy {
  const policy: TaskProviderPolicy = {
    preferredFramework: config.agentType,
    providerSource: providerSourceFor(config),
  };
  const model = modelFor(config);
  if (model !== undefined) policy.model = model;
  return policy;
}

/**
 * Lower a cockpit mode to the `agentType`/`model` subset of {@link SpawnOptions}
 * for the direct ACP spawn path. (Auth/credential injection is resolved by the
 * host, not here.)
 */
export function cockpitModeToSpawnOverrides(
  config: CockpitModeConfig,
): Required<Pick<SpawnOptions, "agentType">> & Pick<SpawnOptions, "model"> {
  const overrides: Required<Pick<SpawnOptions, "agentType">> &
    Pick<SpawnOptions, "model"> = { agentType: config.agentType };
  const model = modelFor(config);
  if (model !== undefined) overrides.model = model;
  return overrides;
}

/**
 * Whether a mode is gated behind the explicit "experimental / TOS-unsafe"
 * opt-in. The cockpit UI must not spawn such a session without the user having
 * armed the experimental gate. The mapping functions above are safe to call for
 * any mode; this guard governs whether the *spawn* is permitted, not the
 * lowering.
 */
export function cockpitModeRequiresExperimentalGate(
  config: CockpitModeConfig,
): config is Extract<CockpitModeConfig, { mode: "experimental" }> {
  return config.mode === "experimental";
}

/** A short, human-facing description of a mode for picker chips / session cards. */
export interface CockpitModeLabel {
  /** Primary label, e.g. "Claude" or "Eliza Cloud". */
  title: string;
  /** Secondary line, e.g. "Fast · gpt-oss-120b" or "Your subscription". */
  subtitle: string;
  /** Compact badge kind for styling. */
  badge: "cloud" | "sub" | "exp";
}

const SUBSCRIPTION_TITLE: Record<SubscriptionFramework, string> = {
  claude: "Claude",
  codex: "Codex",
};

/** Build the picker/card label for a mode. Pure — drives display only. */
export function describeCockpitMode(config: CockpitModeConfig): CockpitModeLabel {
  switch (config.mode) {
    case "eliza-cloud":
      return {
        title: "Eliza Cloud",
        subtitle:
          config.tier === "small"
            ? `Fast · ${ELIZA_CLOUD_TIER_MODEL.small}`
            : `Smart · ${ELIZA_CLOUD_TIER_MODEL.large}`,
        badge: "cloud",
      };
    case "opencode":
      return { title: "OpenCode", subtitle: "Cerebras", badge: "cloud" };
    case "subscription":
      return {
        title: SUBSCRIPTION_TITLE[config.agentType],
        subtitle:
          config.auth === "api_keys" ? "Your API key" : "Your subscription",
        badge: "sub",
      };
    case "experimental":
      return {
        title: `${SUBSCRIPTION_TITLE[config.agentType]} (experimental)`,
        subtitle: "Replay proxy · TOS-unsafe",
        badge: "exp",
      };
  }
}
