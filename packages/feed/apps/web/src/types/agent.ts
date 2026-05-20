/**
 * Agent Types
 *
 * Shared type definitions for agent data structures.
 * Used by both client hooks and server API routes.
 */

/**
 * Metadata fields for an agent profile on-chain update.
 */
export interface AgentProfileMetadata {
  /** Display name */
  name: string;
  /** Username (optional) */
  username?: string | null;
  /** Bio/description (optional) */
  bio?: string | null;
  /** Profile image URL (optional) */
  profileImageUrl?: string | null;
  /** Cover image URL (optional) */
  coverImageUrl?: string | null;
  /** Agent type (default: 'user') */
  type?: "user" | string;
  /** ISO timestamp of update */
  updated?: string;
}
