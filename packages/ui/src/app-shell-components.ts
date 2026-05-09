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

export {
  listAppShellPages,
  registerAppShellPage,
} from "./app-shell-registry";
export type { AppShellPageRegistration } from "./app-shell-registry";
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
