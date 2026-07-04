/**
 * Browser build entry point (the `browser` export condition). Re-exports the
 * domain types and a stub `farcasterPlugin` whose `init` only warns: the real
 * Neynar-backed integration needs server-side credentials, so browsers must call
 * it through a server proxy.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

export type {
  Cast,
  CastEmbed,
  CastId,
  FarcasterConfig,
  FarcasterEventTypes,
  FarcasterMessageType,
  FidRequest,
  Profile,
} from "./types";

/**
 * Browser-safe export boundary.
 *
 * The full Farcaster integration depends on server-side credentials and the Neynar SDK.
 * In browsers, import should succeed, but usage should be disabled (use a server proxy).
 */
export const farcasterPlugin: Plugin = {
  name: "farcaster",
  description: "Farcaster client plugin (browser: use a server proxy)",
  async init(_config, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(
      "[plugin-farcaster] This plugin is not supported directly in browsers. Use a server proxy."
    );
  },
};

export default farcasterPlugin;
