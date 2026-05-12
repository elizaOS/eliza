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
 * `@elizaos/plugin-local-embedding` is intentionally excluded: it pulls in
 * `node-llama-cpp`, which has no Android build. On mobile, embeddings come
 * either from a cloud provider or from the upcoming `llama-cpp-capacitor`
 * JNI binding (separate task).
 */
export const MOBILE_CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql",
  "@elizaos/plugin-background-runner",
  "@elizaos/plugin-device-filesystem",
];

/**
 * ElizaOS-only overlay app plugins. Used when the runtime is the custom
 * Android OS build (`ELIZA_PLATFORM=android` plus `ELIZA_LOCAL_LLAMA=1`),
 * appended to `MOBILE_CORE_PLUGINS` in `collectPluginNames`. Each one is a
 * runtime-app plugin (the `/plugin` subpath of the matching overlay app)
 * that exposes privileged system surfaces — WiFi, Contacts, Phone — to the
 * agent as actions. The overlay UIs themselves register at app boot via
 * `@elizaos/app-{wifi,contacts,phone}/register`, gated on `isElizaOS()` so
 * stock Android, iOS, web, and desktop are no-ops.
 *
 * Stock Android does not get these because Play Store style builds should not
 * expose privileged OS-control surfaces merely because `Capacitor` reports
 * `android`.
 */
export const ELIZAOS_ANDROID_CORE_PLUGINS: readonly string[] = [
  "@elizaos/app-wifi",
  "@elizaos/app-contacts",
  "@elizaos/app-phone",
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
  "@elizaos/plugin-local-embedding", // local embeddings — required for memory
  // @elizaos/plugin-form — standalone form plugin; load via plugin registry/config
  "@elizaos/app-companion", // VRM companion emotes; actions gated until app session is active
  // @elizaos/plugin-agent-orchestrator — opt-in via ELIZA_AGENT_ORCHESTRATOR (Eliza app enables by default)
  // Recurring work uses runtime TaskService + triggers (no @elizaos/plugin-cron).
  "@elizaos/plugin-app-control", // launch, close, and list running Eliza apps from agent chat
  "@elizaos/plugin-device-filesystem", // mobile-safe FILE target=device via Capacitor on iOS/Android, Node fs/promises rooted under resolveStateDir()/workspace on desktop/AOSP
  "@elizaos/plugin-shell", // shell service, approvals, and history provider
  "@elizaos/plugin-coding-tools", // native FILE/SHELL/WORKTREE coding tools (desktop-only
  "@elizaos/plugin-agent-skills", // skill execution and marketplace runtime
  "@elizaos/plugin-commands", // slash command handling (skills auto-register as /commands)
  "@elizaos/app-lifeops", // LifeOps: personal ops — tasks, goals, calendar, inbox, website blocking
  "@elizaos/plugin-browser", // Browser plugin: unified BROWSER + MANAGE_BROWSER_BRIDGE actions; workspace browser + Chrome/Safari companion bridge
  "@elizaos/plugin-video", // Video download / transcription (managed yt-dlp + ffmpeg with auto-update on extractor failure)
  // Built-in runtime capabilities (no longer external plugins):
  // - experience, todos, personality: advanced capabilities (advancedCapabilities: true)
  // - form: standalone @elizaos/plugin-form
  // - trust: core capability (enableTrust: true)
  // - secrets (SECRETS): core capability (enableSecretsManager: true)
  // - plugin-manager: core capability (enablePluginManager: true)
  // - knowledge, relationships, trajectories: native features
];

/**
 * Plugins that can be enabled from the admin panel.
 * Not loaded by default — require explicit configuration or have platform dependencies.
 */
export const OPTIONAL_CORE_PLUGINS: readonly string[] = [
  // plugin-manager, secrets (SECRETS), trust: now built-in core capabilities
  // Enable via character settings: ENABLE_PLUGIN_MANAGER, ENABLE_SECRETS_MANAGER, ENABLE_TRUST
  // "@elizaos/app-lifeops" — moved to CORE_PLUGINS above
  "@elizaos/plugin-pdf", // PDF processing (published bundle broken in alpha.15)
  "@elizaos/plugin-cua", // CUA computer-use agent (cloud sandbox automation)
  "@elizaos/plugin-obsidian", // Obsidian vault CLI integration
  "@elizaos/plugin-repoprompt", // RepoPrompt CLI integration and workflow orchestration
  "@elizaos/plugin-computeruse", // computer use automation (requires platform-specific binaries)
  "@elizaos/plugin-browser", // browser automation (requires stagehand-server)
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
  "@elizaos/plugin-music", // library + playback + streaming routes (unified MUSIC action)
  // "@elizaos/plugin-directives", // directive processing - not yet ready
  // "@elizaos/plugin-mcp", // MCP protocol support - not yet ready
  // "@elizaos/plugin-scheduling", // scheduling - not yet ready
  // todos: now built-in as advanced capability (advancedCapabilities: true)
];
