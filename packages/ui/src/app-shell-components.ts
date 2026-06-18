/**
 * Shell component subset — curated re-exports consumed by App.tsx.
 *
 * When adding a new shell/page component, add it here AND in
 * `./components/index.ts`. Both files must stay in sync.
 *
 * In addition to the static re-exports below, this module re-exports a tiny
 * runtime registry (`registerAppShellPage` / `listAppShellPages`) that lets
 * plugins contribute pages dynamically without app-core hard-coding them.
 * The shell merges these registrations with each loaded plugin's
 * `app.navTabs` declaration and the static page list at render time.
 */

export type { AppShellPageRegistration } from "./app-shell-registry";
export {
  listAppShellPages,
  registerAppShellPage,
} from "./app-shell-registry";
export { GameViewOverlay } from "./components/apps/GameViewOverlay";
export { CharacterEditor } from "./components/character/CharacterEditor";
export { SaveCommandModal } from "./components/chat/SaveCommandModal";
export { ConversationsSidebar } from "./components/conversations/ConversationsSidebar";
export { CustomActionEditor } from "./components/custom-actions/CustomActionEditor";
export { CustomActionsPanel } from "./components/custom-actions/CustomActionsPanel";
export { AppsPageView } from "./components/pages/AppsPageView";
// AutomationsFeed, BrowserWorkspaceView removed: App.tsx lazy-loads them and
// re-exporting from a barrel folds the lazy boundary back into main.
export { DatabasePageView } from "./components/pages/DatabasePageView";
export { DocumentsView } from "./components/pages/DocumentsView";
// HeartbeatsView / HeartbeatsDesktopShell removed: App.tsx renders the
// heartbeats route via the lazy-loaded AutomationsFeed, and re-exporting
// HeartbeatsView from this barrel pulls cron-parser (~25 KB gzip) into main.
export { LogsView } from "./components/pages/LogsView";
export { MemoryViewerView } from "./components/pages/MemoryViewerView";
export { PluginsPageView } from "./components/pages/PluginsPageView";
export { RelationshipsView } from "./components/pages/RelationshipsView";
export { RuntimeView } from "./components/pages/RuntimeView";
// SettingsView, SkillsView, StreamView, TrajectoriesView removed:
// App.tsx lazy-loads them, and re-exporting them from this barrel folds the
// lazy boundary back into the main app chunk.
export { TasksPageView } from "./components/pages/TasksPageView";
// DesktopWorkspaceSection removed: App.tsx lazy-loads it.
export { BugReportModal } from "./components/shell/BugReportModal";
export { ConnectionFailedBanner } from "./components/shell/ConnectionFailedBanner";
export { ConnectionLostOverlay } from "./components/shell/ConnectionLostOverlay";
export { PairingView } from "./components/shell/PairingView";
export { ShellOverlays } from "./components/shell/ShellOverlays";
export { StartupFailureView } from "./components/shell/StartupFailureView";
export { StartupScreen } from "./components/shell/StartupScreen";
export { StartupShell } from "./components/shell/StartupShell";
export { SystemWarningBanner } from "./components/shell/SystemWarningBanner";
export { FineTuningView } from "./components/training/injected";
