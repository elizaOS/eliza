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
 * Browser-safe stub.
 *
 * The full Farcaster integration depends on server-side credentials and the Neynar SDK.
 * In browsers, import should succeed, but usage should be disabled (use a server proxy).
 */
export const farcasterPlugin: Plugin = {
  name: "farcaster",
  description: "Farcaster client plugin (browser: stub, use a server proxy)",
  async init(_config, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(
      "[plugin-farcaster] This plugin is not supported directly in browsers. Use a server proxy."
    );
  },
};

export default farcasterPlugin;
