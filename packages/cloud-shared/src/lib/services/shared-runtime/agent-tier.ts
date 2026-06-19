/**
 * Agent execution tiering — decides HOW an agent runs, so we don't provision a
 * dedicated runtime container for agents that don't need one.
 *
 *   shared           — runs container-free in the shared hosted runtime
 *                      (chat / webhook / cron turns via a hosted LLM). DEFAULT.
 *   dedicated-lazy   — own container, scale-to-zero (wake on use, sleep idle).
 *   dedicated-always — own container, never sleeps (24/7 autonomy, live sockets).
 *   custom           — bring-your-own Docker image.
 *
 * The user never picks a tier: it is derived from the agent's config. A simple
 * chat/webhook agent stays "shared"; only a real need (custom image, an
 * always-on socket plugin, an explicit 24/7 toggle, or a too-large model)
 * escalates it to a container.
 */

export type AgentTier = "shared" | "dedicated-lazy" | "dedicated-always" | "custom";

export interface AgentTierInput {
  /** User explicitly toggled "Always on / 24/7 autonomy". */
  alwaysOn?: boolean;
  /** Bring-your-own Docker image (coding-containers path). */
  dockerImage?: string | null;
  /** Plugin identifiers the agent declares. */
  plugins?: string[];
  /** The agent needs persistent in-process state that can't be reconstructed per-turn. */
  statefulRuntime?: boolean;
  /** The selected model can't run on the shared hosted runtime. */
  modelTooLargeForShared?: boolean;
}

/**
 * Plugins that hold a persistent connection / long-running process and therefore
 * cannot run as discrete shared turns — they need an always-on container.
 * Matched as substrings against plugin ids (e.g. "@elizaos/plugin-discord").
 */
const PERSISTENT_CONNECTION_PLUGINS = [
  "discord",
  "telegram",
  "twitter",
  "farcaster",
  "slack",
  "matrix",
  "irc",
  "websocket",
];

function needsPersistentConnection(plugins: string[] | undefined): boolean {
  if (!plugins?.length) return false;
  return plugins.some((p) => {
    const id = p.toLowerCase();
    return PERSISTENT_CONNECTION_PLUGINS.some((needle) => id.includes(needle));
  });
}

/** Derive the execution tier for an agent from its config. */
export function getAgentTier(input: AgentTierInput): AgentTier {
  if (input.dockerImage && input.dockerImage.trim().length > 0) {
    return "custom";
  }
  if (input.alwaysOn || input.modelTooLargeForShared || input.statefulRuntime) {
    return "dedicated-always";
  }
  if (needsPersistentConnection(input.plugins)) {
    return "dedicated-always";
  }
  return "shared";
}

/** True when the container for this tier should be provisioned eagerly at create time. */
export function tierProvisionsEagerly(tier: AgentTier): boolean {
  // dedicated-always + custom want the box up immediately; dedicated-lazy waits
  // for first use; shared never provisions a container.
  return tier === "dedicated-always" || tier === "custom";
}
