/**
 * Main-tab discovery.
 *
 * Apps declare themselves as the shell's default landing tab by setting
 * `package.json#elizaos.app.mainTab` to `true`. At boot, the shell scans
 * the loaded apps catalog and picks the unique declarer; if none claim
 * the seam, the shell falls back to a built-in placeholder. Multiple
 * declarers are resolved deterministically by alphabetic package name
 * with a warning, so a misconfigured second app never crashes the shell.
 *
 * Phase 1 of the agent + app-core extraction.
 */

import type { RegistryAppInfo } from "@elizaos/shared";
import { packageNameToAppRouteSlug } from "@elizaos/shared";
import { readAppsCache } from "../components/apps/apps-cache";

/** Result of main-tab discovery. */
export interface MainTabApp {
  /** The shell tab id — derived from the app's route slug. */
  tabId: string;
  /** The app's npm package name. */
  appName: string;
}

/**
 * Fallback tab when no installed app declares `elizaos.app.mainTab=true`.
 *
 * Phase 1 of the extraction: while chat is still hardcoded into App.tsx
 * (`case "chat": return <ChatView />`) the fallback stays "chat" so the
 * shell renders identically to before for users with no main-tab app.
 * Phase 5 drops the chat case once `app-chat` claims the seam, at which
 * point this fallback becomes the HomePlaceholderView surface ("home").
 */
export const MAIN_TAB_FALLBACK = "chat" as const;

/** Read the `mainTab` flag, ignoring non-boolean values defensively. */
function declaresMainTab(app: RegistryAppInfo): boolean {
  return app.mainTab === true;
}

/**
 * Discover which app should render as the shell's main tab.
 *
 * Returns `null` when no installed app claims the seam — callers should
 * fall back to a built-in placeholder.
 *
 * If multiple apps declare `mainTab: true`, returns the first one ordered
 * alphabetically by package name and emits a warning. Crashing the shell
 * because of a metadata collision would make the system unusable, so we
 * pick deterministically and let the user resolve it via Settings later.
 */
export function getMainTabApp(apps: RegistryAppInfo[]): MainTabApp | null {
  const declarers = apps.filter(declaresMainTab);
  if (declarers.length === 0) return null;

  declarers.sort((a, b) => a.name.localeCompare(b.name));

  if (declarers.length > 1) {
    const names = declarers.map((a) => a.name).join(", ");
    console.warn(
      `[main-tab] multiple apps declare elizaos.app.mainTab=true (${names}); ` +
        `falling back to "${declarers[0].name}". ` +
        `Set mainTab on exactly one installed app.`,
    );
  }

  const winner = declarers[0];
  const tabId = packageNameToAppRouteSlug(winner.name);
  if (!tabId) return null;

  return { tabId, appName: winner.name };
}

/**
 * Resolve the shell's default landing tab.
 *
 * Reads the cached apps catalog (`readAppsCache()`) synchronously and
 * runs `getMainTabApp()` against it. Used at boot before the apps API
 * call has resolved, so the shell can pick a landing tab without
 * waiting on the network. Falls back to `MAIN_TAB_FALLBACK` ("chat")
 * when:
 *   - the cache is empty (first run), or
 *   - no app declares `mainTab: true`.
 *
 * Optional `apps` argument lets callers supply an already-loaded
 * catalog (post-hydrate) without going through the cache.
 */
export function resolveDefaultLandingTab(apps?: RegistryAppInfo[]): string {
  const catalog = apps ?? readAppsCache();
  if (!catalog) return MAIN_TAB_FALLBACK;
  return getMainTabApp(catalog)?.tabId ?? MAIN_TAB_FALLBACK;
}
