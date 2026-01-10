/**
 * Farcaster Plugin for elizaOS
 *
 * Provides full Farcaster integration for sending and receiving casts,
 * handling mentions, timeline interactions, and webhook support.
 *
 * ## Features
 *
 * - Post casts and replies
 * - Receive and respond to mentions
 * - Timeline and thread providers
 * - Webhook and polling modes
 * - Embed processing (images, videos, frames)
 *
 * ## Configuration
 *
 * Required:
 * - FARCASTER_FID: Your Farcaster FID
 * - FARCASTER_SIGNER_UUID: Neynar signer UUID
 * - FARCASTER_NEYNAR_API_KEY: Neynar API key
 *
 * Optional:
 * - FARCASTER_DRY_RUN: Enable dry run mode (default: false)
 * - FARCASTER_MODE: 'polling' or 'webhook' (default: 'polling')
 * - FARCASTER_POLL_INTERVAL: Polling interval in seconds (default: 120)
 * - MAX_CAST_LENGTH: Max cast length (default: 320)
 * - ENABLE_CAST: Enable auto-casting (default: true)
 * - CAST_INTERVAL_MIN: Min cast interval in minutes (default: 90)
 * - CAST_INTERVAL_MAX: Max cast interval in minutes (default: 180)
 */

import type { Plugin } from "@elizaos/core";
import { FarcasterService } from "./services/FarcasterService";
import { FarcasterTestSuite } from "./__tests__/suite";
import { farcasterActions } from "./actions";
import { farcasterProviders } from "./providers";
import { farcasterWebhookRoutes } from "./routes/webhook";

// Export types and utilities for external use
export {
  EmbedManager,
  isEmbedUrl,
  isEmbedCast,
  type ProcessedEmbed,
} from "./managers/EmbedManager";
export type {
  Cast,
  CastEmbed,
  CastId,
  Profile,
  FarcasterConfig,
  FidRequest,
  FarcasterMessageType,
  FarcasterEventTypes,
} from "./types";
export { FarcasterClient } from "./client/FarcasterClient";
export { FarcasterService } from "./services/FarcasterService";

/**
 * Farcaster plugin for elizaOS.
 *
 * Provides full Farcaster integration including casting, mentions,
 * and timeline interactions.
 */
export const farcasterPlugin: Plugin = {
  name: "farcaster",
  description: "Farcaster client plugin for sending and receiving casts",
  services: [FarcasterService],
  actions: farcasterActions,
  providers: farcasterProviders,
  routes: farcasterWebhookRoutes,
  tests: [new FarcasterTestSuite()],
};

export default farcasterPlugin;

