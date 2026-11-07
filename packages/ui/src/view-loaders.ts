/** Async UI entrypoints preserve route, voice, and wallet loading boundaries. */
export const loadBackgroundView = () =>
  import("./components/pages/BackgroundView.js");
export const loadCharacterEditor = () =>
  import("./components/character/CharacterEditor.js");
export const loadAutomationsFeed = () =>
  import("./components/pages/AutomationsFeed.js");
export const loadBrowserWorkspaceView = () =>
  import("./components/pages/BrowserWorkspaceView.js");
export const loadLiveMeetingPage = () =>
  import("./components/transcripts/LiveMeetingPage.js");
export const loadCameraPageView = () =>
  import("./components/pages/CameraPageView.js");
export const loadDesktopWorkspaceSection = () =>
  import("./components/settings/DesktopWorkspaceSection.js");
export const loadSettingsView = () =>
  import("./components/pages/SettingsView.js");
export const loadVaultPageView = () =>
  import("./components/pages/VaultPageView.js");
export const loadStreamView = () => import("./components/pages/StreamView.js");
export const loadDatabasePageView = () =>
  import("./components/pages/DatabasePageView.js");
export const loadFilesView = () => import("./components/pages/FilesView.js");
export const loadLogsView = () => import("./components/pages/LogsView.js");
export const loadMemoryViewerView = () =>
  import("./components/pages/MemoryViewerView.js");
export const loadPluginsPageView = () =>
  import("./components/pages/PluginsPageView.js");
export const loadCharacterExperienceView = () =>
  import("./components/character/CharacterExperienceView.js");
export const loadCharacterSkillsView = () =>
  import("./components/character/CharacterSkillsView.js");
export const loadRuntimeView = () =>
  import("./components/pages/RuntimeView.js");
export const loadSkillsView = () => import("./components/pages/SkillsView.js");
export const loadTasksPageView = () =>
  import("./components/pages/TasksPageView.js");
export const loadTrajectoriesView = () =>
  import("./components/pages/TrajectoriesView.js");
export const loadSecretsManagerSection = () =>
  import("./components/settings/SecretsManagerSection.js");
export const loadRemoteControlCloudDefault = () =>
  import("./api/remote-control-cloud-default.js");
export async function loadVoiceBootstrap() {
  const [aec, diarization, jni, desktopWake] = await Promise.all([
    import("./voice/aec-loop-harness.js"),
    import("./voice/audio-frame-diarization-harness.js"),
    import("./voice/jni-voice-harness.js"),
    import("./voice/fused-wake-desktop-bridge.js"),
  ]);
  return {
    installAecLoopHarness: aec.installAecLoopHarness,
    installDiarizationPumpHarness: diarization.installDiarizationPumpHarness,
    installJniVoiceHarness: jni.installJniVoiceHarness,
    registerDesktopFusedWake: desktopWake.registerDesktopFusedWake,
  };
}
export const loadWebAppsStudio = () =>
  import("./cloud/applications/WebAppsStudio.js");
export const loadNativeAppsStudio = () =>
  import("./cloud/applications/NativeAppsStudio.js");
export const loadContextInspectorView = () =>
  import("./components/ContextInspectorView.js");
export const loadAppWindowRenderer = () =>
  import("./components/apps/AppWindowRenderer.js");
export const loadShellViewAgentSurface = () =>
  import("./components/views/ShellViewAgentSurface.js");
export const loadCloudRouterShell = () =>
  import("./cloud/shell/CloudRouterShell.js");
export const loadManagedCloudPage = () =>
  import("./cloud/shell/ManagedCloudPage.js");
export const loadDeveloperWorkspace = () =>
  import("./components/developer/DeveloperWorkspace.js");
export const loadConversationsSidebar = () =>
  import("./components/conversations/ConversationsSidebar.js");
export const loadChatView = () => import("./components/pages/ChatView.js");
export const loadTriggersView = () =>
  import("./components/pages/TriggersView.js");

export const loadViewInteractRegistry = () =>
  import("./components/views/view-interact-registry.js");

export const loadClockView = () => import("./components/pages/ClockView.js");
