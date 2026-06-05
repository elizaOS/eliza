/**
 * Shared types for the view registry.
 *
 * Extracted from views-registry.ts to break the views-registry ↔
 * views-search-index circular dependency.
 *
 * @module api/view-registry-types
 */

import type { ViewDeclaration, ViewType } from "@elizaos/core";
import type { AgentPlatform } from "./platform-detect.ts";

export interface ViewRegistryEntry extends ViewDeclaration {
  /** Concrete presentation type after applying the default (`gui`). */
  viewType: ViewType;
  /** Owning plugin name. */
  pluginName: string;
  /** Absolute path to the plugin's package root, if resolvable. */
  pluginDir?: string;
  /** Resolved URL served by the agent: `/api/views/<id>/bundle.js`. */
  bundleUrl?: string;
  /** Resolved URL served by the agent: `/api/views/<id>/hero`. */
  heroImageUrl?: string;
  /**
   * True when a real hero image asset exists on disk for this view. When false,
   * `heroImageUrl` still resolves (the route serves a generated fallback),
   * but the client should render the view's icon instead of that fallback.
   */
  hasHeroImage: boolean;
  /** True when the bundle file exists on disk. */
  available: boolean;
  /** Unix timestamp (ms) when this entry was registered. */
  loadedAt: number;
  /**
   * Platform this view is available on. Populated from
   * `ViewDeclaration.platforms` (first entry) or defaults to "web".
   * Used by platform-aware route filtering to gate dynamic bundles on
   * restricted platforms (iOS App Store, Google Play).
   */
  platform: AgentPlatform;
  /** First 12 hex chars of the SHA-256 content hash of the bundle file. */
  bundleHash?: string;
  /** Bundle URL with `?v=<hash>` for immutable long-lived caching. */
  bundleUrlVersioned?: string;
  /** Bundle file size in bytes. */
  bundleSize?: number;
  /**
   * True for entries registered by the built-in shell itself
   * (pluginName === "@elizaos/builtin"). These views live in the main
   * bundle and have no separate bundle file.
   */
  builtin?: boolean;
}
