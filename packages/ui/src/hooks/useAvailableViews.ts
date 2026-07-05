/**
 * Fetches the available views from `GET /api/views` — the primary data source
 * for Launcher, returning the `ViewRegistryEntry` list.
 *
 * Polls every 30s (the endpoint is a cheap in-memory registry list). An
 * unreachable endpoint degrades to an empty list so Launcher still renders.
 */

import type {
  AppShellBackgroundPolicy,
  SurfaceManifest,
  ViewHeaderPolicy,
  ViewKind,
} from "@elizaos/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { client } from "../api";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import { fetchWithCsrf } from "../api/csrf-client";
import {
  type AppShellPageRegistration,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  subscribeAppShellPages,
} from "../app-shell-registry";
import {
  type BuiltinTab,
  isAospShellEnabled,
  TAB_PATHS,
  titleForTab,
} from "../navigation";
import { getFrontendPlatform } from "../platform/platform-guards";
import { useAppSelector } from "../state/app-store";
import type { StartupPhaseValue } from "../state/startup-coordinator";
import { isShellPaintable } from "../state/startup-coordinator";
import { startPolling } from "./resource-cache";
import { useCachedResource } from "./useCachedResource";

export interface ViewRegistryEntry {
  /** Stable unique identifier for the view, e.g. "wallet.inventory". */
  id: string;
  /** Human-readable label shown in the view manager. */
  label: string;
  /** Presentation/runtime family. Defaults to "gui". */
  viewType?: "gui" | "tui" | "xr";
  /** One-line description shown in the view card. */
  description?: string;
  /** Lucide icon name or data-URI for the card icon. */
  icon?: string;
  /** Navigation path this view is mounted at, e.g. "/apps/wallet". */
  path?: string;
  /**
   * URL from which the view's JS bundle can be fetched dynamically.
   * e.g. "/api/views/wallet.inventory/bundle.js"
   * Absent for views that are already registered in-process.
   */
  bundleUrl?: string;
  /**
   * URL of a complete HTML document for `surface.isolation: "sandboxed-iframe"`
   * views. This is mounted as an iframe `src`; it is not imported as JS.
   */
  frameUrl?: string;
  /** Named export inside the bundle to mount. Defaults to "default". */
  componentExport?: string;
  /** Public URL of a preview image to show in the view card. */
  heroImageUrl?: string;
  /**
   * True when a real hero image exists for this view. When false, `heroImageUrl`
   * resolves to a generated fallback image, so the card renders the icon instead.
   */
  hasHeroImage?: boolean;
  /** Whether the view is currently loadable. */
  available: boolean;
  /**
   * Declared surface contract for this view (#13452), forwarded from the owning
   * `ViewDeclaration.surface` by `GET /api/views`. The shell derives the screen
   * background from it (`surface.background` gated by the `wallpaper` grant), and
   * DynamicViewLoader derives the plugin view's capability grants from it. The
   * standalone `backgroundPolicy` / `headerPolicy` below are the legacy fallback.
   */
  surface?: SurfaceManifest;
  /**
   * Screen background policy for this view. Defaults to `"opaque"`. Superseded
   * by `surface.background` when a manifest is declared.
   */
  backgroundPolicy?: AppShellBackgroundPolicy;
  /**
   * Top-bar framing policy (#13586). Defaults to `"normal"`; the shell enforces
   * the shared `ViewHeader` on every `normal` view. `fullscreen`/`modal`/
   * `immersive` opt a view out of the uniform top bar. Superseded by
   * `surface.header` when a manifest is declared.
   */
  headerPolicy?: ViewHeaderPolicy;
  /** The plugin that provides this view. */
  pluginName: string;
  /** Freeform tags used for search and filtering. */
  tags?: string[];
  /** Sort priority for launcher/nav surfaces (lower = earlier). */
  order?: number;
  /** Optional named group shared with app-shell page registrations. */
  group?: string;
  /**
   * When true, the view only appears when Developer Mode is enabled.
   * Equivalent to `viewKind: "developer"`.
   */
  developerOnly?: boolean;
  /**
   * Four-tier visibility category. Supersedes `developerOnly` when set:
   * `system`/`release` always show; `developer`/`preview` follow Settings
   * toggles. See `ViewKind` in `@elizaos/core`.
   */
  viewKind?: ViewKind;
  /** When false, the view is hidden from the manager grid (internal views). */
  visibleInManager?: boolean;
  /**
   * When true, this view is an internal-tool app the homescreen launcher may
   * pin. Declared on the owning `ViewDeclaration`; the launcher builds its
   * pinnable list from this flag instead of a hardcoded package-name table.
   */
  pinnable?: boolean;
  /** Named capabilities the view exposes (informational). */
  capabilities?: Array<{ id: string; description: string }>;
  /**
   * True when this view is a first-party shell view (chat, settings, etc.)
   * rather than a dynamically loaded plugin view.
   */
  builtin?: boolean;
  /** When true, the view can be pinned as a native desktop tab in the Electrobun shell. */
  desktopTabEnabled?: boolean;
  /**
   * True when this view is a native device-OS surface that only exists on the
   * AOSP ElizaOS fork (phone/messages/contacts/camera). Stripped from the view
   * set on every non-AOSP build. Declared on the owning `ViewDeclaration`.
   */
  nativeOs?: boolean;
}

interface UseAvailableViewsResult {
  views: ViewRegistryEntry[];
  loading: boolean;
  error: Error | null;
  /** Re-fetches immediately. */
  refresh: () => void;
}

interface UseAvailableViewsOptions {
  /**
   * Network calls to /api/views are only useful once a backend-backed shell is
   * paintable. Local builtin/registered views remain available while disabled.
   */
  networkEnabled?: boolean;
}

const POLL_INTERVAL_MS = 30_000;

async function fetchViewList(
  viewType?: "gui" | "tui" | "xr",
): Promise<ViewRegistryEntry[]> {
  const platform = getFrontendPlatform();
  const response = await fetchWithCsrf(
    `/api/views${viewType ? `?viewType=${viewType}` : ""}`,
    {
      headers: { "X-Eliza-Platform": platform },
    },
  );
  if (!response.ok) {
    throw new Error(`GET /api/views returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as unknown;
  if (!data || typeof data !== "object" || !("views" in data)) {
    return [];
  }
  const { views } = data as { views: unknown };
  if (!Array.isArray(views)) return [];
  return views as ViewRegistryEntry[];
}

/**
 * One-shot fetch of the `/api/views` registry for non-React consumers (the apps
 * catalog loaders) that need to overlay live plugin ViewDeclaration metadata
 * onto the internal-tool catalog. Returns an empty list if the endpoint is
 * unavailable — callers fall back to the static internal-tool declarations.
 */
export async function fetchAvailableViews(): Promise<ViewRegistryEntry[]> {
  try {
    return await fetchViews();
  } catch {
    return [];
  }
}

async function fetchViews(): Promise<ViewRegistryEntry[]> {
  const [guiResult, tuiResult, xrResult] = await Promise.allSettled([
    fetchViewList(),
    fetchViewList("tui"),
    fetchViewList("xr"),
  ]);
  const guiViews = guiResult.status === "fulfilled" ? guiResult.value : [];
  const tuiViews =
    tuiResult.status === "fulfilled"
      ? tuiResult.value.filter((view) => view.viewType === "tui")
      : [];
  const xrViews =
    xrResult.status === "fulfilled"
      ? xrResult.value.filter((view) => view.viewType === "xr")
      : [];
  if (
    guiResult.status === "rejected" &&
    tuiResult.status === "rejected" &&
    xrResult.status === "rejected" &&
    !String(guiResult.reason).includes("404") &&
    !String(tuiResult.reason).includes("404") &&
    !String(xrResult.reason).includes("404")
  ) {
    throw guiResult.reason;
  }
  const merged = new Map<string, ViewRegistryEntry>();
  for (const view of guiViews) {
    merged.set(`${view.viewType ?? "gui"}:${view.id}`, view);
  }
  for (const view of tuiViews) {
    merged.set(`tui:${view.id}`, view);
  }
  for (const view of xrViews) {
    merged.set(`xr:${view.id}`, view);
  }
  return [...merged.values()];
}

const VIEWS_CACHE_KEY = "views:available";

const EMPTY_VIEWS: ViewRegistryEntry[] = [];

// Per-tab Lucide glyph names for the builtin shell views, so each launcher
// tile renders a DISTINCT icon instead of collapsing onto the generic
// LayoutGrid fallback. Names must exist in ViewIcon's ICONS map; an id with no
// entry here falls through to the keyword guesser, then LayoutGrid.
const TAB_ICON_NAMES: Partial<Record<BuiltinTab, string>> = {
  chat: "MessageSquare",
  phone: "Phone",
  messages: "MessageSquare",
  contacts: "UsersRound",
  camera: "AppWindow",
  tasks: "ListTodo",
  browser: "Globe",
  stream: "Radio",
  apps: "LayoutGrid",
  views: "LayoutGrid",
  character: "Bot",
  "character-select": "Users",
  automations: "Zap",
  triggers: "Zap",
  inventory: "Wallet",
  documents: "FileText",
  files: "FolderClosed",
  plugins: "Plug",
  skills: "Sparkles",
  advanced: "BrainCircuit",
  "fine-tuning": "BrainCircuit",
  trajectories: "Activity",
  transcripts: "FileText",
  relationships: "Network",
  experience: "GraduationCap",
  "character-skills": "Sparkles",
  memories: "BrainCircuit",
  rolodex: "UsersRound",
  runtime: "Terminal",
  database: "Database",
  desktop: "Monitor",
  settings: "Settings",
  tutorial: "Sparkles",
  logs: "ScrollText",
  background: "ImageIcon",
};

const BUILTIN_TAB_ORDER: Partial<Record<BuiltinTab, number>> =
  Object.fromEntries(
    [
      "settings",
      "phone",
      "messages",
      "contacts",
      "tasks",
      "files",
      "documents",
      "browser",
      "inventory",
      "transcripts",
      "memories",
      "relationships",
      "automations",
      "triggers",
      "plugins",
      "skills",
      "trajectories",
      "runtime",
      "database",
      "logs",
      "stream",
      "desktop",
    ].map((id, index) => [id, index * 10]),
  );

const BUILTIN_SHELL_VIEW_ENTRIES: ViewRegistryEntry[] = Object.entries(
  TAB_PATHS,
).map(([id, path]) => ({
  id,
  label: titleForTab(id as BuiltinTab),
  viewType: "gui",
  icon: TAB_ICON_NAMES[id as BuiltinTab],
  path,
  available: true,
  pluginName: "@elizaos/builtin",
  tags: [id],
  order: BUILTIN_TAB_ORDER[id as BuiltinTab],
  builtin: true,
  visibleInManager: false,
  desktopTabEnabled: true,
}));

/**
 * Map an in-process app-shell page (registered by a plugin via
 * `registerAppShellPage`) to a view-registry entry. On iOS/Android the agent's
 * `/api/views` strips every view that has a dynamic `bundleUrl` (no remote JS
 * allowed by store policy), so a plugin view whose component is bundled into
 * the renderer would never appear in the manager even though it renders fine
 * in-process. Surfacing the registry here makes those views loadable: the card
 * navigates to the registered path and the shell mounts the bundled component.
 */
function appShellPageToViewEntry(
  page: AppShellPageRegistration,
): ViewRegistryEntry {
  return {
    id: page.id,
    label: page.label,
    viewType: "gui",
    icon: page.icon,
    path: page.path,
    available: true,
    pluginName: page.pluginId,
    developerOnly: page.developerOnly,
    viewKind: page.viewKind,
    order: page.order,
    group: page.group,
    surface: page.surface,
    backgroundPolicy: page.backgroundPolicy,
    headerPolicy: page.headerPolicy,
    visibleInManager: true,
    builtin: false,
  };
}

// Version-cached snapshot of the app-shell registry as view entries.
// useSyncExternalStore requires getSnapshot to return a referentially stable
// value between renders, so we only rebuild the array when the registry's
// version actually changes.
let cachedAppShellVersion = -1;
let cachedAppShellViewEntries: ViewRegistryEntry[] = EMPTY_VIEWS;

function getAppShellViewEntriesSnapshot(): ViewRegistryEntry[] {
  const version = getAppShellPageRegistrySnapshot();
  if (version !== cachedAppShellVersion) {
    cachedAppShellVersion = version;
    // The registry holds GUI nav pages, but some plugins also register `.tui` /
    // `.xr` variants of a page under a suffixed id. The view manager is the GUI
    // surface, so skip those non-GUI variants (the base `.id` GUI page stays).
    const pages = listAppShellPages().filter((p) => !/\.(tui|xr)$/.test(p.id));
    cachedAppShellViewEntries =
      pages.length === 0 ? EMPTY_VIEWS : pages.map(appShellPageToViewEntry);
  }
  return cachedAppShellViewEntries;
}

/**
 * Merge the agent's network views with the in-process app-shell registry,
 * deduped by `viewType:id`. Network entries win (richer metadata: hero, bundle)
 * — app-shell pages only fill ids the network didn't return, which on mobile is
 * every dynamically-bundled plugin view the route filtered out.
 */
function mergeViewRegistryEntries(
  primaryViews: ViewRegistryEntry[],
  fallbackGroups: ViewRegistryEntry[][],
): ViewRegistryEntry[] {
  if (fallbackGroups.every((group) => group.length === 0)) {
    return primaryViews;
  }
  const byKey = new Map<string, ViewRegistryEntry>();
  for (const view of primaryViews) {
    byKey.set(`${view.viewType ?? "gui"}:${view.id}`, view);
  }
  for (const group of fallbackGroups) {
    for (const entry of group) {
      const key = `${entry.viewType ?? "gui"}:${entry.id}`;
      if (!byKey.has(key)) byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

function mergeWithAppShellViews(
  networkViews: ViewRegistryEntry[],
  appShellViews: ViewRegistryEntry[],
): ViewRegistryEntry[] {
  return mergeViewRegistryEntries(networkViews, [appShellViews]);
}

export function withBuiltinShellViews(
  views: ViewRegistryEntry[],
): ViewRegistryEntry[] {
  return mergeViewRegistryEntries(views, [BUILTIN_SHELL_VIEW_ENTRIES]);
}

function useDefaultViewsNetworkEnabled(): boolean {
  const phase = useAppSelector((s) => s.startupCoordinator?.phase);
  if (!supportsFullAppShellRoutes(client.getBaseUrl())) return false;
  if (typeof phase !== "string") return true;
  // first-run-required is now shell-paintable (onboarding runs in the live
  // chat), but the agent does not exist yet — don't fetch network view
  // registries until onboarding completes and the runtime is booting.
  if (phase === "first-run-required") return false;
  return isShellPaintable(phase as StartupPhaseValue);
}

export function useAvailableViews(
  options: UseAvailableViewsOptions = {},
): UseAvailableViewsResult {
  const defaultNetworkEnabled = useDefaultViewsNetworkEnabled();
  const networkEnabled = options.networkEnabled ?? defaultNetworkEnabled;
  // All mounts share one cache slot, so the router and the desktop-tab consumer
  // (which both mount this hook) issue a single request and paint instantly on
  // revisit instead of each re-fetching cold.
  const resource = useCachedResource<ViewRegistryEntry[]>(
    VIEWS_CACHE_KEY,
    () => fetchViews(),
    { staleTime: POLL_INTERVAL_MS, enabled: networkEnabled },
  );

  // Runtime plugin install/uninstall changes the registry; keep a background
  // poll so the list stays live. The poll is ref-counted in the cache layer
  // keyed by VIEWS_CACHE_KEY, so the router and desktop-tab consumer (which
  // both mount this hook) share a single timer instead of each running one.
  const { refetch } = resource;
  useEffect(() => {
    if (!networkEnabled) return;
    return startPolling(VIEWS_CACHE_KEY, fetchViews, POLL_INTERVAL_MS);
  }, [networkEnabled]);

  // In-process plugin views (registered via registerAppShellPage) are merged in
  // so they appear in the manager even when the agent route filtered them out
  // (mobile strips dynamic-bundle views). The snapshot is version-cached, so
  // this only re-renders when a plugin (un)registers a page.
  const appShellViews = useSyncExternalStore(
    subscribeAppShellPages,
    getAppShellViewEntriesSnapshot,
    getAppShellViewEntriesSnapshot,
  );
  const networkViews =
    resource.status === "success" ? resource.data : EMPTY_VIEWS;
  const views = useMemo(() => {
    const merged = mergeWithAppShellViews(networkViews, appShellViews);
    // Native device-OS surfaces (phone, messages, contacts, camera) exist only
    // on the AOSP ElizaOS fork. Each such view declares `nativeOs: true` on its
    // `ViewDeclaration`; strip them from the view manager + router on every
    // non-AOSP build (web, desktop, iOS, stock Play-Store Android), matching the
    // AOSP-gated home tiles (`nativeOs`) and the route gates in App.tsx.
    if (isAospShellEnabled()) return merged;
    return merged.filter((view) => !view.nativeOs);
  }, [networkViews, appShellViews]);

  return {
    views,
    loading: networkEnabled && resource.status === "loading",
    error: resource.status === "error" ? resource.error : null,
    refresh: networkEnabled ? refetch : () => {},
  };
}

export function useRoutableViews(
  options: UseAvailableViewsOptions = {},
): UseAvailableViewsResult {
  const { views, loading, error, refresh } = useAvailableViews(options);
  const routableViews = useMemo(() => withBuiltinShellViews(views), [views]);

  return useMemo(
    () => ({
      views: routableViews,
      loading,
      error,
      refresh,
    }),
    [routableViews, loading, error, refresh],
  );
}
