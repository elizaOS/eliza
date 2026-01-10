/**
 * @elizaos/plugin-twitter - Browser Entry Point
 *
 * Provides Twitter/X API v2 integration types and utilities for browser environments.
 * Note: Full Twitter client functionality requires server-side execution due to CORS.
 */

// Export types and utilities that can work in browser
export * from "./types";

// Browser-compatible exports
export { TwitterEventTypes } from "./types";
export type {
  Tweet,
  MediaData,
  ActionResponse,
  TwitterConfig,
} from "./types";

