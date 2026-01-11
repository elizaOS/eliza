/**
 * @elizaos/plugin-xai - Browser Entry Point
 *
 * Provides xAI types for browser environments.
 * Note: Full X client functionality requires server-side execution due to CORS.
 */

// Export types that work in browser
export type {
  ActionResponse,
  ITwitterClient,
  IXClient,
  MediaData,
  Tweet,
  TwitterConfig,
} from "./types";
