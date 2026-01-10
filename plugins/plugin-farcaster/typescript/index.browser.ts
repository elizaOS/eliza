/**
 * Browser entry point for the Farcaster plugin.
 *
 * This file re-exports types and browser-safe utilities only.
 * Services and managers that require Node.js are not exported.
 */

// Export types (safe for browser)
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

// Export the plugin definition
export { farcasterPlugin, default } from "./index";
