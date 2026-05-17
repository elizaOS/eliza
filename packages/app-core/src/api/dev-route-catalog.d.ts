/**
 * Dev route catalog for the QA crawler.
 *
 * **Why this module:** the QA crawler needs a single source of truth for every UI surface
 * (tab paths, settings sub-sections, modal triggers, feature-flag gates). Without it, the
 * crawler maintains its own hardcoded list and drifts the moment a tab is renamed or a
 * settings section is added.
 *
 * The canonical tab map lives in `@elizaos/ui` (`packages/ui/src/navigation/index.ts` —
 * `TAB_PATHS`). Importing the UI package from app-core would create a renderer dependency
 * for an HTTP handler, so this module mirrors the small flat list of route entries as a
 * local constant. The companion vitest at `dev-route-catalog.test.ts` imports the real
 * `TAB_PATHS` and asserts every key is represented here — so drift is caught at test time,
 * not in production.
 *
 * Loopback-only by convention (mounted alongside `/api/dev/stack` in `dev-compat-routes.ts`).
 */
export declare const ELIZA_DEV_ROUTE_CATALOG_SCHEMA_VERSION: 1;
/**
 * Where a route is reachable. `all` is the desktop + web default; the gated values match
 * the existing feature-flag / platform-gate logic in `packages/ui/src/navigation/index.ts`
 * and `App.tsx`.
 */
export type DevRouteVisibility = "all" | "android" | "desktop" | "dev-mode";
export type DevRoutePlatformGate = "ios" | "android" | "desktop" | "web" | null;
export interface DevRouteEntry {
  /** Built-in tab id from `@elizaos/ui` (`BuiltinTab`). */
  tabId: string;
  /** Pathname the tab resolves to. */
  path: string;
  /** Human-readable label (matches `titleForTab`). */
  label: string;
  /** Which `ALL_TAB_GROUPS` group hosts the tab (or "Hidden" for addressable-but-ungrouped). */
  group: string;
  visibility: DevRouteVisibility;
  /** Vite env var that gates the route, when one exists. */
  featureFlag: string | null;
  requiresAuth: boolean;
  platformGate: DevRoutePlatformGate;
}
export interface DevRouteSettingsSection {
  id: string;
  label: string;
}
export interface DevRouteModal {
  id: string;
  /** Shortest accurate description of what triggers the modal. */
  trigger: string;
}
export interface DevRouteCatalogPayload {
  schemaVersion: typeof ELIZA_DEV_ROUTE_CATALOG_SCHEMA_VERSION;
  generatedAt: string;
  routes: DevRouteEntry[];
  settingsSections: DevRouteSettingsSection[];
  modals: DevRouteModal[];
}
export declare function buildRouteCatalog(now?: Date): DevRouteCatalogPayload;
//# sourceMappingURL=dev-route-catalog.d.ts.map
