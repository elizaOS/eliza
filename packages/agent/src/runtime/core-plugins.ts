/** Platform eligibility and load ordering for agent host plugins. */
export interface CorePluginProfile {
  readonly plugin: string;
  readonly desktopOnly?: boolean;
  readonly mobileCore?: boolean;
  readonly viewEveryPlatform?: boolean;
  readonly aospCore?: boolean;
  readonly aospTerminal?: boolean;
  readonly aospTerminalOrder?: number;
  readonly requiredBootstrap?: boolean;
}

export const CORE_PLUGIN_PROFILE_METADATA: readonly CorePluginProfile[] = [
  {
    plugin: "agent-orchestrator",
    desktopOnly: true,
    aospTerminal: true,
    aospTerminalOrder: 2,
  },
  { plugin: "coding-tools", desktopOnly: true },
  { plugin: "@elizaos/plugin-sql", mobileCore: true, requiredBootstrap: true },
  { plugin: "@elizaos/plugin-native-filesystem", mobileCore: true },
  { plugin: "@elizaos/plugin-browser", mobileCore: true },
  { plugin: "@elizaos/plugin-vision", mobileCore: true },
  { plugin: "@elizaos/plugin-scheduling", mobileCore: true },
  { plugin: "@elizaos/plugin-agent-orchestrator/ui", viewEveryPlatform: true },
  { plugin: "@elizaos/plugin-inbox", viewEveryPlatform: true },
  { plugin: "@elizaos/plugin-notes", viewEveryPlatform: true },
  { plugin: "@elizaos/plugin-calendar", viewEveryPlatform: true },
  { plugin: "@elizaos/plugin-todos", viewEveryPlatform: true },
  { plugin: "@elizaos/plugin-native-wifi", aospCore: true },
  { plugin: "@elizaos/plugin-native-contacts", aospCore: true },
  { plugin: "@elizaos/plugin-native-phone", aospCore: true },
  { plugin: "@elizaos/app/mobile-remote-target", aospCore: true },
  {
    plugin: "@elizaos/plugin-coding-tools",
    aospTerminal: true,
    aospTerminalOrder: 1,
  },
];

export function selectCorePluginsByProfile(
  predicate: (entry: CorePluginProfile) => boolean | undefined,
): readonly string[] {
  return CORE_PLUGIN_PROFILE_METADATA.filter((entry) =>
    Boolean(predicate(entry)),
  ).map((entry) => entry.plugin);
}

export const REQUIRED_BOOTSTRAP_PLUGINS: readonly string[] =
  selectCorePluginsByProfile((entry) => entry.requiredBootstrap);

export const DESKTOP_ONLY_PLUGINS: readonly string[] =
  selectCorePluginsByProfile((entry) => entry.desktopOnly);
export const MOBILE_CORE_PLUGINS: readonly string[] =
  selectCorePluginsByProfile((entry) => entry.mobileCore);

export const MOBILE_MODEL_PROVIDER_PLUGINS: readonly string[] = [
  "@elizaos/plugin-anthropic",
  "@elizaos/plugin-openai",
  "@elizaos/plugin-elizacloud",
];
export const MOBILE_VIEW_PLUGINS: readonly string[] =
  selectCorePluginsByProfile((entry) => entry.viewEveryPlatform);
export const ELIZAOS_ANDROID_CORE_PLUGINS: readonly string[] =
  selectCorePluginsByProfile((entry) => entry.aospCore);
export const ELIZAOS_ANDROID_TERMINAL_PLUGINS: readonly string[] =
  CORE_PLUGIN_PROFILE_METADATA.filter((entry) => entry.aospTerminal)
    .slice()
    .sort((a, b) => (a.aospTerminalOrder ?? 0) - (b.aospTerminalOrder ?? 0))
    .map((entry) => entry.plugin);

export const CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql", // database adapter — required
  "@elizaos/plugin-local-inference", // local Eliza-1 inference (text + embeddings + voice) — required for memory + on-device generation
  "@elizaos/plugin-native-filesystem", // mobile-safe FILE target=device via Capacitor on iOS/Android, Node fs/promises rooted under resolveStateDir()/workspace on desktop/AOSP
  "@elizaos/plugin-coding-tools", // native FILE/SHELL/WORKTREE coding tools + shell service, approvals, and history provider (desktop-only
  "@elizaos/plugin-browser", // Browser workspace and Chrome/Safari companion bridge.
  "@elizaos/plugin-scheduling", // always-loaded ScheduledTask runtime primitive (runner host + REST surface + seed registry); personal-assistant enriches it when present
  "@elizaos/plugin-knowledge", // Knowledge CRUD/search routes required by the web and desktop Knowledge surface
];

export const LEAN_CHAT_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql", // database adapter — required
  "@elizaos/plugin-local-inference", // text + embeddings + voice — required for memory + generation
  "@elizaos/plugin-notes", // managed Cloud Notes data and capabilities
  "@elizaos/plugin-todos", // UI-free personal Todo action/provider on local PGlite
  "@elizaos/plugin-knowledge", // Knowledge CRUD/search routes exposed to hosted web clients
  "@elizaos/plugin-scheduling",
  "@elizaos/plugin-native-filesystem", // mobile-safe FILE target
];

export const LEAN_CHAT_EXCLUDED_PLUGINS: readonly string[] = [
  "@elizaos/plugin-coding-tools",
  "@elizaos/plugin-browser",
  "agent-orchestrator",
  "@elizaos/plugin-agent-orchestrator",
  "@elizaos/plugin-gitpathologist",
  "@elizaos/plugin-pty",
  "@elizaos/plugin-local-inference",
  "@elizaos/plugin-wallet",
  "@elizaos/plugin-workflow",
];

export const BLOCKING_CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql", // required database adapter
  "@elizaos/plugin-local-inference", // pre-init local model/embedding handler wiring
  "@elizaos/plugin-scheduling",
];

export const DEFERRED_CORE_PLUGINS: readonly string[] = CORE_PLUGINS.filter(
  (pluginName) => !BLOCKING_CORE_PLUGINS.includes(pluginName),
);

export const OPTIONAL_CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-google-workspace", // Google Workspace connector (requires googleapis + explicit OAuth config); only loaded when LifeOps/Google is enabled
  "@elizaos/plugin-personal-assistant", // LifeOps: personal ops - tasks, goals, calendar, inbox, website blocking. The Eliza app manifest enables it and requires registration before ready (#17023); standalone agent installs stay opt-in because they do not ship this package.
  "@elizaos/plugin-pdf", // PDF processing (published bundle broken in alpha.15)
  "@elizaos/plugin-obsidian", // Obsidian vault CLI integration
  "@elizaos/plugin-repoprompt", // RepoPrompt CLI integration and workflow orchestration
  "@elizaos/plugin-computeruse", // computer use automation (requires platform-specific binaries)
  "@elizaos/plugin-browser", // browser automation (app/bridge first, optional stagehand fallback)
  "@elizaos/plugin-vision", // vision/image understanding (feature-gated)
  "@elizaos/plugin-discord", // Discord bot integration
  "@elizaos/plugin-telegram", // Telegram bot integration
  "@elizaos/plugin-elevenlabs", // ElevenLabs text-to-speech
  "@elizaos/plugin-music", // Library, playback, and streaming routes.
  "@elizaos/plugin-gitpathologist", // forensic git-history analysis (opt-in via ELIZA_GITPATHOLOGIST, auto-on when .git/ exists)
];
