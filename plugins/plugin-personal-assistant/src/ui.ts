// Renderer-safe browser entry for @elizaos/plugin-personal-assistant.
//
// plugin-personal-assistant intentionally does NOT register a renderer view of
// its own anymore — the legacy /lifeops dashboard was removed in the lifeops
// decomposition, and domain views moved to plugin-todos, plugin-inbox,
// plugin-goals, plugin-health, plugin-calendar, plugin-documents,
// plugin-blocker, plugin-finances, and plugin-relationships.
//
// What this file still serves: the renderer alias in packages/app/vite.config.ts
// maps `@elizaos/plugin-personal-assistant` to this file so the browser bundle
// can import the package without dragging in the server-side surface (discord,
// health, phone, calendly, browser-bridge, native modules). Keeping a thin
// browser facade prevents Vite from following those imports through src/plugin.ts
// or src/index.ts.
//
// We still register the side-effectful API client so renderer callers can hit
// the PA HTTP routes (BRIEF / PRIORITIZE / scheduled-task CRUD / approvals).
//
// The two settings-card components that survived the view kill remain exported
// here because packages/app/src/main.tsx still imports them via lazyNamedComponent.

import "./api/client-lifeops.js";

export * from "./components/AppBlockerSettingsCard.js";
export * from "./components/WebsiteBlockerSettingsCard.js";
export type {
  AppBlockerSettingsCardProps,
  AppBlockerSettingsMode,
  WebsiteBlockerSettingsCardProps,
  WebsiteBlockerSettingsMode,
} from "./types/index.js";
