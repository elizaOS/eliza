/**
 * Shell component subset — curated re-exports consumed by App.tsx.
 *
 * When adding a new shell/page component, add it here AND in
 * `./components/index.ts`. Both files must stay in sync.
 *
 * In addition to the static re-exports below, this module exposes a tiny
 * runtime registry (`registerAppShellPage` / `listAppShellPages`) that lets
 * plugins contribute pages dynamically without app-core hard-coding them.
 * The shell merges these registrations with each loaded plugin's
 * `app.navTabs` declaration and the static page list at render time.
 */

import type { ComponentType } from "react";

export { GameViewOverlay } from "./components/apps/GameViewOverlay";
export { CharacterEditor } from "./components/character/CharacterEditor";
export { SaveCommandModal } from "./components/chat/SaveCommandModal";
export { ConversationsSidebar } from "./components/conversations/ConversationsSidebar";
export { CustomActionEditor } from "./components/custom-actions/CustomActionEditor";
export { CustomActionsPanel } from "./components/custom-actions/CustomActionsPanel";
export { AppsPageView } from "./components/pages/AppsPageView";
export {
  AutomationsDesktopShell,
  AutomationsView,
} from "./components/pages/AutomationsView";
export { BrowserWorkspaceView } from "./components/pages/BrowserWorkspaceView";
export { ChatView } from "./components/pages/ChatView";
export { ConnectorsPageView } from "./components/pages/ConnectorsPageView";
export { DatabasePageView } from "./components/pages/DatabasePageView";
export { DocumentsView } from "./components/pages/DocumentsView";
export {
  HeartbeatsDesktopShell,
  HeartbeatsView,
} from "./components/pages/HeartbeatsView";
export { LogsView } from "./components/pages/LogsView";
export { MemoryViewerView } from "./components/pages/MemoryViewerView";
export { PluginsPageView } from "./components/pages/PluginsPageView";
export { RelationshipsView } from "./components/pages/RelationshipsView";
export { RuntimeView } from "./components/pages/RuntimeView";
export { SettingsView } from "./components/pages/SettingsView";
export { SkillsView } from "./components/pages/SkillsView";
export { StreamView } from "./components/pages/StreamView";
export { TasksPageView } from "./components/pages/TasksPageView";
export { TrajectoriesView } from "./components/pages/TrajectoriesView";
export { DesktopWorkspaceSection } from "./components/settings/DesktopWorkspaceSection";
export { BugReportModal } from "./components/shell/BugReportModal";
export { ConnectionFailedBanner } from "./components/shell/ConnectionFailedBanner";
export { ConnectionLostOverlay } from "./components/shell/ConnectionLostOverlay";
export { Header } from "./components/shell/Header";
export { PairingView } from "./components/shell/PairingView";
export { ShellOverlays } from "./components/shell/ShellOverlays";
export { StartupFailureView } from "./components/shell/StartupFailureView";
export { StartupShell } from "./components/shell/StartupShell";
export { SystemWarningBanner } from "./components/shell/SystemWarningBanner";
export { FineTuningView } from "./components/training/injected";

/**
 * A page contributed at runtime by a plugin or host app. Mirrors the fields
 * on `PluginAppNavTab` from `@elizaos/core`, plus the resolved React
 * component the shell will mount.
 *
 * Plugins that ship a bundled React component should call
 * `registerAppShellPage` at module-load time (e.g. from the host app's
 * boot config). Plugins that use the `componentExport` convention (e.g.
 * `"@elizaos/app-wallet/ui#InventoryView"`) can skip registration —
 * the shell loads the export dynamically the first time the page renders.
 */
export interface AppShellPageRegistration {
  /** Stable id, scoped to the owning plugin (e.g. `"wallet.inventory"`). */
  id: string;
  /** Owning plugin id. */
  pluginId: string;
  /** Display label in the tab bar / nav. */
  label: string;
  /** Lucide icon name. */
  icon?: string;
  /** Route path the tab links to. */
  path: string;
  /** Sort priority within the nav (lower = first). Default 100. */
  order?: number;
  /** When true, only visible when Developer Mode is enabled in Settings. */
  developerOnly?: boolean;
  /** Optional named group the tab belongs to. */
  group?: string;
  /** The React component the shell mounts when this page is active. */
  Component: ComponentType<unknown>;
}

interface AppShellPageRegistryStore {
  entries: Map<string, AppShellPageRegistration>;
}

const APP_SHELL_PAGE_REGISTRY_KEY = Symbol.for(
  "elizaos.app-core.app-shell-page-registry",
);

function getRegistryStore(): AppShellPageRegistryStore {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const existing = globalObject[APP_SHELL_PAGE_REGISTRY_KEY] as
    | AppShellPageRegistryStore
    | null
    | undefined;
  if (existing) return existing;
  const created: AppShellPageRegistryStore = {
    entries: new Map<string, AppShellPageRegistration>(),
  };
  globalObject[APP_SHELL_PAGE_REGISTRY_KEY] = created;
  return created;
}

export function registerAppShellPage(
  registration: AppShellPageRegistration,
): void {
  getRegistryStore().entries.set(registration.id, registration);
}

export function listAppShellPages(): AppShellPageRegistration[] {
  return [...getRegistryStore().entries.values()];
}
