/**
 * Browser entry point for the Farcaster plugin.
 *
 * This file re-exports types and browser-safe utilities only.
 * Services and managers that require Node.js are not exported.
 */

// Export the plugin definition
export { default, farcasterPlugin } from "./index";
// Export types (safe for browser)
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
