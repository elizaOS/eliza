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
export const DESKTOP_ONLY_PLUGINS: readonly string[] = ["agent-orchestrator"];

/**
 * Mobile-safe core plugins. Used when `MILADY_PLATFORM=android` (or `ios`).
 *
 * Phones cannot host the n8n sidecar, the Signal CLI, the swarm orchestrator,
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
];

/** Core plugins that should always be loaded. collectPluginNames() seeds from this list only. */
export const CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql", // database adapter — required
  "@elizaos/plugin-local-embedding", // local embeddings — required for memory
  // @elizaos/app-form — now built-in as advanced capability (form); enabled when advancedCapabilities: true
  "@elizaos/app-companion", // VRM companion emotes; actions gated until app session is active
  // @elizaos/plugin-agent-orchestrator — opt-in via ELIZA_AGENT_ORCHESTRATOR (Eliza app enables by default)
  "@elizaos/plugin-cron", // scheduled jobs and automation
  "@elizaos/plugin-app-control", // launch, close, and list running Milady apps from agent chat
  "@elizaos/plugin-shell", // shell command execution
  "@elizaos/plugin-agent-skills", // skill execution and marketplace runtime
  "@elizaos/plugin-commands", // slash command handling (skills auto-register as /commands)
  "@elizaos/app-lifeops", // LifeOps: personal ops — tasks, goals, calendar, inbox, website blocking
  "@elizaos/plugin-browser-bridge", // Agent Browser Bridge: Chrome/Safari companion pairing, tab + page context sync, packaging artifacts
  // Built-in runtime capabilities (no longer external plugins):
  // - experience, form, clipboard, personality: advanced capabilities (advancedCapabilities: true)
  // - trust: core capability (enableTrust: true)
  // - secrets-manager: core capability (enableSecretsManager: true)
  // - plugin-manager: core capability (enablePluginManager: true)
  // - knowledge, relationships, trajectories: native features
];

/**
 * Plugins that can be enabled from the admin panel.
 * Not loaded by default — require explicit configuration or have platform dependencies.
 */
export const OPTIONAL_CORE_PLUGINS: readonly string[] = [
  // plugin-manager, secrets-manager, trust: now built-in core capabilities
  // Enable via character settings: ENABLE_PLUGIN_MANAGER, ENABLE_SECRETS_MANAGER, ENABLE_TRUST
  // "@elizaos/app-lifeops" — moved to CORE_PLUGINS above
  "@elizaos/plugin-pdf", // PDF processing (published bundle broken in alpha.15)
  "@elizaos/plugin-cua", // CUA computer-use agent (cloud sandbox automation)
  "@elizaos/plugin-obsidian", // Obsidian vault CLI integration
  "@elizaos/plugin-code", // code writing and file operations
  "@elizaos/plugin-repoprompt", // RepoPrompt CLI integration and workflow orchestration
  "@elizaos/plugin-claude-code-workbench", // Claude Code companion workflows for this monorepo
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
  "@elizaos/plugin-music-library", // music metadata, library, playlists, YouTube search
  "@elizaos/plugin-music-player", // music playback engine + streaming routes
  // "@elizaos/plugin-directives", // directive processing - not yet ready
  // "@elizaos/plugin-mcp", // MCP protocol support - not yet ready
  // "@elizaos/plugin-scheduling", // scheduling - not yet ready
  // clipboard: now built-in as advanced capability (advancedCapabilities: true)
];
