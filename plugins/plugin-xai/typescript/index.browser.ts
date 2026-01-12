/**
 * @elizaos/plugin-xai - Browser Entry Point
 *
 * Provides xAI types for browser environments.
 * Full X client functionality requires server-side execution due to CORS.
 */

export type { TwitterConfig } from "./environment";
// Export types that work in browser
export type {
  ActionResponse,
  IXClient,
  MediaData,
  Post,
} from "./types";
