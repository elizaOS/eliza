/**
 * Core plugin package lists shared by runtime startup and the API server.
 *
 * Keeping this in a standalone module avoids a circular dependency between
 * `api/server.ts` and `runtime/eliza.ts`.
 */

/**
 * Plugins that depend on PTY/native workspace tooling.
 * Keep them out of cloud images where those binaries are intentionally absent.
 */
export const DESKTOP_ONLY_PLUGINS: readonly string[] = [
  "agent-orchestrator",
  "coding-tools",
];

/**
 * Mobile-safe core plugins. Used when `ELIZA_PLATFORM=android` (or `ios`).
 *
 * Phones cannot host the workflow runtime, the Signal CLI, the swarm orchestrator,
 * the sandbox engine, the desktop launch hooks, or the autonomous PTY tools.
 * They also have no `/usr/bin/open`, `osascript`, `xdg-open`, `ffmpeg`,
 * `wmctrl`, etc., so plugins that bind to those at init crash the runtime.
 *
 * The mobile boot ships only `@elizaos/plugin-sql` (PGlite-backed memory
 * store, required) plus AI provider plugins (`@elizaos/plugin-anthropic`,
 * `@elizaos/plugin-openai`, `@elizaos/plugin-ollama`) which `collectPluginNames`
 * adds based on the user's API keys. They are statically imported in the agent
 * runtime so they bundle cleanly without filesystem-based plugin resolution.
 *
 * `@elizaos/plugin-local-inference` is intentionally excluded from the
 * default mobile boot list: it pulls in the bun:ffi desktop dylib path plus
 * a sizeable runtime (catalog, mtp subprocess client, voice pipeline)
 * that the Capacitor WebView agent does not need. On mobile, embeddings
 * come either from a cloud provider, the WebView-side llama-cpp-capacitor
 * binding, or the AOSP-only FFI bridge
 * (`@elizaos/plugin-aosp-local-inference`) when `ELIZA_LOCAL_LLAMA=1`.
 */
export const MOBILE_CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql",
  "@elizaos/plugin-background-runner",
  "@elizaos/plugin-device-filesystem",
];

/**
 * View-providing plugins that must register their `/api/views` entries on EVERY
 * platform — including stock mobile — so their home tiles resolve to a real
 * destination instead of dead-ending in the apps catalog. These are bundled
 * statically and either ship no backend or degrade gracefully without one (the
 * heavy backends they pair with, e.g. agent-orchestrator, stay gated
 * separately). Seeded into the load set for all platforms and spread into the
 * mobile allow-list so the mobile filter keeps them.
 */
export const MOBILE_VIEW_PLUGINS: readonly string[] = [
  "@elizaos/plugin-task-coordinator",
  // Inbox: registered on mobile so its home tile resolves + the /inbox view
  // appears in /api/views. The plugin's de-stub + client wiring are owned by a
  // separate effort; this keeps it in the mobile load/allow set.
  "@elizaos/plugin-inbox",
];

/**
 * ElizaOS-only overlay app plugins. Used when the runtime is the custom
 * Android OS build (`ELIZA_PLATFORM=android` plus `ELIZA_LOCAL_LLAMA=1`),
 * appended to `MOBILE_CORE_PLUGINS` in `collectPluginNames`. Each one is a
 * runtime-app plugin (the `/plugin` subpath of the matching overlay app)
 * that exposes privileged system surfaces — WiFi, Contacts, Phone — to the
 * agent as actions. The overlay UIs themselves register at app boot via
 * `@elizaos/plugin-{wifi,contacts,phone}/register`, gated on `isElizaOS()` so
 * stock Android, iOS, web, and desktop leave them inactive.
 *
 * Stock Android does not get these because Play Store style builds should not
 * expose privileged OS-control surfaces merely because `Capacitor` reports
 * `android`.
 */
export const ELIZAOS_ANDROID_CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-wifi",
  "@elizaos/plugin-contacts",
  "@elizaos/plugin-phone",
];

/**
 * Terminal / shell / coding-tool plugins available on the privileged AOSP
 * build only. The privileged Android service spawns bun under the priv_app
 * SELinux context which permits `execve`, so shell, native file actions, and
 * subprocess-backed coding-agent orchestration can work where they would not on
 * stock Android.
 *
 * Stock Play-Store Android cannot have these — `execve` of arbitrary binaries
 * is blocked by the default SELinux policy and would also fail Play review.
 */
export const ELIZAOS_ANDROID_TERMINAL_PLUGINS: readonly string[] = [
  "@elizaos/plugin-shell",
  "@elizaos/plugin-coding-tools",
  "agent-orchestrator",
];

/** Core plugins that should always be loaded. collectPluginNames() seeds from this list only. */
export const CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql", // database adapter — required
  "@elizaos/plugin-local-inference", // local Eliza-1 inference (text + embeddings + voice) — required for memory + on-device generation
  // @elizaos/plugin-form — standalone form plugin; load via plugin registry/config
  "@elizaos/plugin-companion", // VRM companion emotes; actions gated until app session is active
  // @elizaos/plugin-agent-orchestrator — opt-in via ELIZA_AGENT_ORCHESTRATOR (Eliza app enables by default)
  // Recurring work uses runtime TaskService + triggers (no @elizaos/plugin-cron).
  "@elizaos/plugin-app-control", // launch, close, and list running Eliza apps from agent chat
  "@elizaos/plugin-device-filesystem", // mobile-safe FILE target=device via Capacitor on iOS/Android, Node fs/promises rooted under resolveStateDir()/workspace on desktop/AOSP
  "@elizaos/plugin-shell", // shell service, approvals, and history provider
  "@elizaos/plugin-coding-tools", // native FILE/SHELL/WORKTREE coding tools (desktop-only
  "@elizaos/plugin-agent-skills", // skill execution and marketplace runtime
  "@elizaos/plugin-commands", // slash command handling (skills auto-register as /commands)
  "@elizaos/plugin-browser", // Browser workspace and Chrome/Safari companion bridge.
  // Built-in runtime capabilities (no longer external plugins):
  // - experience, todos, personality: advanced capabilities (advancedCapabilities: true)
  // - form: standalone @elizaos/plugin-form
  // - trust: core capability (enableTrust: true)
  // - secrets (SECRETS): core capability (enableSecretsManager: true)
  // - plugin-manager: core capability (enablePluginManager: true)
  // - knowledge, relationships, trajectories: native features
];

/**
 * Core plugins that must be imported and registered before the runtime can be
 * considered ready. Keep this list intentionally small: everything else in
 * CORE_PLUGINS should load in the deferred phase so slow feature/provider
 * imports do not block API readiness.
 */
export const BLOCKING_CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql", // required database adapter
  "@elizaos/plugin-local-inference", // pre-init local model/embedding handler wiring
];

/**
 * Core plugins loaded after runtime readiness. Dependency ordering is handled
 * by preregisterCorePluginsInDependencyWaves() in eliza.ts.
 *
 * These are imported in the BACKGROUND after `ready:true` (runDeferredBoot in
 * eliza.ts). They are NOT candidates for further first-use lazy loading: every
 * one registers a provider (so the planner prompt knows the capability exists),
 * an action the model must be able to select, or a service/event listener with
 * a boot-time obligation. Deferring any of them behind a stub that imports on
 * first invocation would silently strip the capability from the planner's
 * awareness — the model cannot ask for an action or read a provider that has
 * not registered yet. Concretely, in this set:
 *   - companion       — PLAY_EMOTE action + VRM views
 *   - app-control     — app launch/close/list actions
 *   - shell           — shell service + shell-history provider
 *   - coding-tools    — FILE/SHELL/WORKTREE actions + available-tools provider
 *   - agent-skills    — USE_SKILL action + enabled-skills provider
 *   - commands        — slash-command provider + command registry
 *   - browser         — browser actions + bridge routes
 * The genuinely on-demand connector/feature plugins that have NO boot
 * obligation (e.g. plugin-video — service-only, reached via getService(VIDEO);
 * and the orchestrator's task-coordinator companion — views-only metadata) are
 * not in this core set: they enter via plugin-collector only when configured,
 * and their boot cost is resolver/staging overhead, not module-body evaluation
 * that a lazy import could avoid (their server modules import only `type`-level
 * symbols). The heaviest deferred imports measured (agent-orchestrator,
 * shell, coding-tools, commands) all register providers/actions or eager-start
 * event-subscribing services and therefore must stay at boot. See
 * benchmarks/loadperf/research/03-agent-boot-plugins.md.
 *
 * Cloud-hosted topology (deploymentTarget.runtime === "cloud") never reaches
 * this set: startEliza() returns startInCloudMode() before the deferred-boot
 * machinery is even defined, so a cloud-proxied agent loads ZERO deferred
 * plugins by construction (no local AgentRuntime boots) — the device-local
 * plugins above are skipped wholesale in that topology with no extra gating.
 */
export const DEFERRED_CORE_PLUGINS: readonly string[] = CORE_PLUGINS.filter(
  (pluginName) => !BLOCKING_CORE_PLUGINS.includes(pluginName),
);

/**
 * Plugins that can be enabled from the admin panel.
 * Not loaded by default — require explicit configuration or have platform dependencies.
 */
export const OPTIONAL_CORE_PLUGINS: readonly string[] = [
  // plugin-manager, secrets (SECRETS), trust: now built-in core capabilities
  // Enable via character settings: ENABLE_PLUGIN_MANAGER, ENABLE_SECRETS_MANAGER, ENABLE_TRUST
  "@elizaos/plugin-google", // Google Workspace connector (requires googleapis + explicit OAuth config); only loaded when LifeOps/Google is enabled
  "@elizaos/plugin-personal-assistant", // LifeOps: personal ops - tasks, goals, calendar, inbox, website blocking (requires @capacitor/core + plugin-google); enable explicitly
  "@elizaos/plugin-finances", // Owner finances dashboard (app_finances schema); auto-registered by plugin-personal-assistant, also enablable standalone
  "@elizaos/plugin-pdf", // PDF processing (published bundle broken in alpha.15)
  "@elizaos/plugin-cua", // CUA computer-use agent (cloud sandbox automation)
  "@elizaos/plugin-obsidian", // Obsidian vault CLI integration
  "@elizaos/plugin-repoprompt", // RepoPrompt CLI integration and workflow orchestration
  "@elizaos/plugin-computeruse", // computer use automation (requires platform-specific binaries)
  "@elizaos/plugin-browser", // browser automation (app/bridge first, optional stagehand fallback)
  "@elizaos/plugin-vision", // vision/image understanding (feature-gated)
  "@elizaos/plugin-cli", // CLI interface
  "@elizaos/plugin-discord", // Discord bot integration
  "@elizaos/plugin-discord-local", // Local Discord desktop integration for macOS
  "@elizaos/plugin-bluebubbles", // BlueBubbles-backed iMessage integration for macOS
  "@elizaos/plugin-telegram", // Telegram bot integration
  "@elizaos/plugin-signal", // Signal user-account integration
  "@elizaos/plugin-twitch", // Twitch integration
  "@elizaos/plugin-edge-tts", // text-to-speech (Microsoft Edge TTS)
  "@elizaos/plugin-elevenlabs", // ElevenLabs text-to-speech
  "@elizaos/plugin-music", // Library, playback, and streaming routes.
  "@elizaos/plugin-gitpathologist", // forensic git-history analysis (opt-in via ELIZA_GITPATHOLOGIST, auto-on when .git/ exists)
  // "@elizaos/plugin-directives", // directive processing remains opt-in
  // "@elizaos/plugin-mcp", // MCP protocol support remains opt-in
  // "@elizaos/plugin-scheduling", // scheduling remains opt-in
  // todos: now built-in as advanced capability (advancedCapabilities: true)
];
