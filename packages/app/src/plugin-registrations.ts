/**
 * Plugin view registrations — all plugin/app module dynamic imports in one place.
 *
 * TEMPORARY: This file consolidates the dynamic imports that were previously
 * inlined inside `initializeAppModules()` in `main.tsx`. The next phase will
 * replace these bundled imports with true dynamic loading from `/api/views`,
 * so each plugin's UI bundle is fetched on demand when the user navigates to
 * a view rather than eagerly at app startup.
 *
 * Until that transition is complete, importing this file triggers all plugin
 * registrations as side effects so the shell behaves identically to before.
 */

// These imports are intentionally side-effect-only. The plugins register
// themselves into the app-shell registry when their module initializes.
// See packages/ui/src/app-shell-registry.ts for the registry API.

// NOTE: These are NOT static top-level imports — they remain as dynamic imports
// called from initializeAppModules() in main.tsx. This file documents and
// centralizes the list of plugins that are loaded eagerly at startup.
//
// When migrating to dynamic view loading from /api/views:
//   1. Remove each entry from initializeAppModules() in main.tsx
//   2. Let the ViewManagerPage + DynamicViewLoader handle on-demand loading
//   3. Delete this file once all plugins are lazily loaded via /api/views

export const EAGERLY_LOADED_SIDE_EFFECT_PLUGINS = [
  "@elizaos/app-babylon",
  "@elizaos/app-scape",
  "@elizaos/app-hyperscape",
  "@elizaos/app-2004scape",
  "@elizaos/app-defense-of-the-agents",
  "@elizaos/app-clawville",
  "@elizaos/app-trajectory-logger",
  "@elizaos/app-shopify",
  "@elizaos/app-hyperliquid",
  "@elizaos/app-polymarket",
  "@elizaos/app-wallet",
  "@elizaos/app-contacts/register",
  "@elizaos/app-device-settings/register",
  "@elizaos/app-messages/register",
  "@elizaos/app-phone/register",
  "@elizaos/app-wifi/register",
] as const;
