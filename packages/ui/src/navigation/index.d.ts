/**
 * Navigation — tabs + onboarding.
 */
import type { LucideIcon } from "lucide-react";
/** Apps are enabled by default; opt-out via VITE_ENABLE_APPS=false. */
export declare const APPS_ENABLED: boolean;
/** Stream routes stay addressable; the nav hides the tab unless streaming is enabled. */
export declare const STREAM_ENABLED = true;
/** Companion tab — enabled by default; opt-out via VITE_ENABLE_COMPANION_MODE=false. */
export declare const COMPANION_ENABLED: boolean;
/** Built-in tab identifiers. */
export type BuiltinTab =
  | "chat"
  | "phone"
  | "messages"
  | "contacts"
  | "lifeops"
  | "tasks"
  | "automations"
  | "browser"
  | "companion"
  | "stream"
  | "apps"
  | "views"
  | "character"
  | "character-select"
  | "inventory"
  | "documents"
  | "triggers"
  | "plugins"
  | "skills"
  | "advanced"
  | "fine-tuning"
  | "trajectories"
  | "relationships"
  | "memories"
  | "rolodex"
  | "voice"
  | "runtime"
  | "database"
  | "desktop"
  | "settings"
  | "logs";
/**
 * Tab identifier — includes all built-in tabs plus arbitrary strings
 * for dynamic plugin-provided nav-page widgets.
 */
export type Tab = BuiltinTab | (string & {});
export declare const APPS_TOOL_TABS: readonly [
  "lifeops",
  "plugins",
  "skills",
  "fine-tuning",
  "trajectories",
  "relationships",
  "memories",
  "runtime",
  "database",
  "logs",
  "advanced",
];
export declare function isAppsToolTab(tab: Tab): boolean;
export interface TabGroup {
  label: string;
  tabs: Tab[];
  icon: LucideIcon;
  description?: string;
}
export interface AndroidPhoneSurfaceDetection {
  platform?: string;
  isNative?: boolean;
  search?: string;
  hash?: string;
}
export declare function isAndroidPhoneSurfaceEnabled(
  detection?: AndroidPhoneSurfaceDetection,
): boolean;
interface WindowNavigationLocation {
  protocol: string;
  search: string;
  hash: string;
  pathname: string;
}
export declare function isAppWindowRoute(
  location?: Pick<WindowNavigationLocation, "search"> | undefined,
): boolean;
export declare function shouldUseHashNavigation(
  location?: Pick<WindowNavigationLocation, "protocol" | "search"> | undefined,
): boolean;
export declare function getWindowNavigationPath(
  location?: WindowNavigationLocation | undefined,
): string;
export declare const ALL_TAB_GROUPS: TabGroup[];
/** A plugin-provided nav-page widget that should appear in the navigation. */
export interface DynamicNavTab {
  /** Tab ID — used as the route path segment. */
  tabId: string;
  /** Human-readable label for the nav button. */
  label: string;
  /** Which existing TabGroup to join, or a new group label to create. */
  navGroup?: string;
  /** Icon for new groups (lucide component). Falls back to Gamepad2. */
  icon?: LucideIcon;
  /** Description for new groups. */
  description?: string;
}
/** Compute visible tab groups. Pass feature flags explicitly for React reactivity. */
export declare function getTabGroups(
  streamEnabled?: boolean,
  walletEnabled?: boolean,
  browserEnabled?: boolean,
  dynamicTabs?: DynamicNavTab[],
  phoneSurfaceEnabled?: boolean,
  automationsEnabled?: boolean,
): TabGroup[];
export declare const TAB_PATHS: Record<BuiltinTab, string>;
export declare function pathForTab(tab: Tab, basePath?: string): string;
export declare function canonicalPathForPath(
  _pathname: string,
  _basePath?: string,
): string | null;
export declare function isRouteRootPath(
  pathname: string,
  basePath?: string,
): boolean;
export declare function resolveInitialTabForPath(
  pathname: string,
  fallbackTab: Tab,
  basePath?: string,
): Tab;
export declare function tabFromPath(
  pathname: string,
  basePath?: string,
): Tab | null;
/**
 * Extract an app slug from a `/apps/<slug>` path.
 * Returns `null` when the path doesn't contain a slug segment.
 */
export declare function getAppSlugFromPath(
  pathname: string,
  basePath?: string,
): string | null;
export declare function titleForTab(tab: Tab): string;
export {
  getMainTabApp,
  MAIN_TAB_FALLBACK,
  type MainTabApp,
  resolveDefaultLandingTab,
} from "./main-tab";
//# sourceMappingURL=index.d.ts.map
