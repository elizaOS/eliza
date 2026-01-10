/**
 * @elizaos/plugin-xai - Browser Entry Point
 *
 * Provides xAI types for browser environments.
 * Note: Full X client functionality requires server-side execution due to CORS.
 */

// Export types that work in browser
export type {
  Tweet,
  MediaData,
  ActionResponse,
  IXClient,
  ITwitterClient,
  TwitterConfig,
} from "./types";
