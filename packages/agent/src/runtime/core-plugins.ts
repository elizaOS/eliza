/**
 * Core plugin package lists shared by runtime startup and the API server.
 *
 * Keeping this in a standalone module avoids a circular dependency between
 * `api/server.ts` and `runtime/eliza.ts`.
 *
 * ## Platform/profile eligibility (arch-audit #12089 item 2)
 *
 * Platform and profile membership USED to live in five hand-maintained,
 * order-coupled name lists (`DESKTOP_ONLY_PLUGINS`, `MOBILE_CORE_PLUGINS`,
 * `MOBILE_VIEW_PLUGINS`, `ELIZAOS_ANDROID_CORE_PLUGINS`,
 * `ELIZAOS_ANDROID_TERMINAL_PLUGINS`). A plugin's eligibility for a given
 * platform was a fact about the plugin, but it was asserted centrally in the
 * host and had to be re-typed into whichever list(s) it belonged to. That is
 * exactly the drift trap the audit flagged: adding a mobile-safe plugin meant
 * remembering to touch `MOBILE_CORE_PLUGINS`, and there was no single place
 * that said "this plugin runs on mobile."
 *
 * Eligibility now lives in ONE declarative capability table
 * ({@link CORE_PLUGIN_PROFILE_METADATA}); the host filters that table by
 * capability. The legacy name lists below are DERIVED from the table via
 * {@link selectCorePluginsByProfile} — they remain as a stable, host-owned
 * read surface (nothing else in the codebase has to change), but they are no
 * longer an independent source that can drift. `plugin-sql` is the only entry
 * marked `requiredBootstrap`; everything else is opt-in-by-capability.
 *
 * A drift-guard test (`core-plugins-profile-metadata.test.ts`) asserts the
 * derived lists still match the historical membership and that exactly one
 * plugin is required bootstrap, so a future edit to the table that silently
 * changes a platform load set fails CI instead of shipping.
 */

/**
 * Declarative platform/profile capability flags for a single core plugin.
 *
 * Each flag answers a capability question about the plugin, not a placement
 * question about a list. The host reads these to build every platform load set,
 * so a plugin declaring (say) `mobileCore: true` is the single fact that puts it
 * on the mobile boot — no parallel list to keep in sync.
 */
export interface CorePluginProfile {
  /** Package name / plugin id as it appears in the load set. */
  readonly plugin: string;
  /**
   * Requires PTY / native workspace tooling that cloud images intentionally
   * omit. Seeds {@link DESKTOP_ONLY_PLUGINS}.
   */
  readonly desktopOnly?: boolean;
  /**
   * Safe to load on the stock mobile (`ELIZA_PLATFORM=android|ios`) boot: no
   * subprocess/launcher/PTY dependency that would crash the app sandbox at
   * init. Seeds {@link MOBILE_CORE_PLUGINS}.
   */
  readonly mobileCore?: boolean;
  /**
   * Registers `/api/views` entries that must resolve on EVERY platform
   * (including stock mobile) so home tiles have a real destination. These are
   * views-only or degrade gracefully without a backend. Seeds
   * {@link MOBILE_VIEW_PLUGINS}.
   */
  readonly viewEveryPlatform?: boolean;
  /**
   * Privileged AOSP-only overlay app plugin (WiFi/Contacts/Phone). Appended to
   * the mobile set only on the custom ElizaOS Android build. Seeds
   * {@link ELIZAOS_ANDROID_CORE_PLUGINS}.
   */
  readonly aospCore?: boolean;
  /**
   * Terminal/shell/coding-tool plugin available only on the privileged AOSP
   * build (priv_app SELinux context permits `execve`). Seeds
   * {@link ELIZAOS_ANDROID_TERMINAL_PLUGINS}.
   */
  readonly aospTerminal?: boolean;
  /**
   * Explicit load-order rank within {@link ELIZAOS_ANDROID_TERMINAL_PLUGINS}.
   * `agent-orchestrator` also carries `desktopOnly` (so it must lead the
   * desktop list), but historically loaded LAST among AOSP terminal plugins;
   * this rank decouples the terminal load order from the table's row order so
   * both derived lists keep their historical ordering. Lower ranks first;
   * unset defaults to 0.
   */
  readonly aospTerminalOrder?: number;
  /**
   * Must be imported and registered before the runtime is considered ready —
   * the required bootstrap dependency. Only `plugin-sql` carries this.
   */
  readonly requiredBootstrap?: boolean;
}

/**
 * Single source of truth for platform/profile plugin eligibility. Order is
 * preserved per selector; the derived lists keep the exact ordering the old
 * hand-lists shipped so no load-order behavior changes.
 *
 * Adding a platform-eligible plugin = add a row (or a flag to an existing row)
 * here. Do NOT reintroduce a parallel name list — derive from this table.
 */
export const CORE_PLUGIN_PROFILE_METADATA: readonly CorePluginProfile[] = [
  // Desktop-only (PTY/native workspace tooling; absent from cloud images).
  // agent-orchestrator is also an AOSP terminal surface, but loads LAST there
  // (aospTerminalOrder: 2) while leading the desktop list.
  {
    plugin: "agent-orchestrator",
    desktopOnly: true,
    aospTerminal: true,
    aospTerminalOrder: 2,
  },
  { plugin: "coding-tools", desktopOnly: true },
  // Mobile-safe core boot. `plugin-sql` is the required bootstrap dependency.
  { plugin: "@elizaos/plugin-sql", mobileCore: true, requiredBootstrap: true },
  { plugin: "@elizaos/plugin-background-runner", mobileCore: true },
  { plugin: "@elizaos/plugin-native-filesystem", mobileCore: true },
  { plugin: "@elizaos/plugin-vision", mobileCore: true },
  { plugin: "@elizaos/plugin-scheduling", mobileCore: true },
  // View-providing plugins that must resolve their home tiles on every platform.
  { plugin: "@elizaos/plugin-task-coordinator", viewEveryPlatform: true },
  { plugin: "@elizaos/plugin-inbox", viewEveryPlatform: true },
  { plugin: "@elizaos/plugin-app-control", viewEveryPlatform: true },
  // Privileged ElizaOS-Android overlay app plugins (system surfaces).
  { plugin: "@elizaos/plugin-wifi", aospCore: true },
  { plugin: "@elizaos/plugin-contacts", aospCore: true },
  { plugin: "@elizaos/plugin-phone", aospCore: true },
  // Privileged AOSP terminal/shell/coding surfaces (priv_app SELinux execve).
  { plugin: "@elizaos/plugin-shell", aospTerminal: true, aospTerminalOrder: 0 },
  {
    plugin: "@elizaos/plugin-coding-tools",
    aospTerminal: true,
    aospTerminalOrder: 1,
  },
];

/**
 * Host-owned capability filter: derive an ordered load set from the metadata
 * table for a given profile predicate. This is the "host filters by capability"
 * primitive the audit calls for — a plugin's eligibility is read off its
 * declared flags, not looked up in a placement list.
 */
export function selectCorePluginsByProfile(
  predicate: (entry: CorePluginProfile) => boolean | undefined,
): readonly string[] {
  return CORE_PLUGIN_PROFILE_METADATA.filter((entry) =>
    Boolean(predicate(entry)),
  ).map((entry) => entry.plugin);
}

/**
 * The single required-bootstrap plugin (`plugin-sql`). Exposed so callers can
 * assert the invariant instead of hardcoding the name.
 */
export const REQUIRED_BOOTSTRAP_PLUGINS: readonly string[] =
  selectCorePluginsByProfile((entry) => entry.requiredBootstrap);

/**
 * Plugins that depend on PTY/native workspace tooling.
 * Keep them out of cloud images where those binaries are intentionally absent.
 *
 * Derived from {@link CORE_PLUGIN_PROFILE_METADATA} (`desktopOnly`) — legacy
 * host-owned read surface, no longer an independent list.
 */
export const DESKTOP_ONLY_PLUGINS: readonly string[] =
  selectCorePluginsByProfile((entry) => entry.desktopOnly);

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
// Mobile-safe boot notes (kept here as the rationale for the metadata flags):
// - plugin-vision (EPIC #9105) is mobile-safe: `sharp` is lazy-loaded with a
//   pure-JS fallback, native YOLO/face detectors are dynamic-imported, and
//   VisionService degrades gracefully on a phone (no capture tool → warns).
// - plugin-scheduling is the always-loaded ScheduledTask runtime primitive;
//   its deps are core/shared/drizzle + the peer plugin-sql, it imports no
//   app-core/agent, and probes host capabilities via ELIZA_PLATFORM.
// Membership is declared via `mobileCore` in CORE_PLUGIN_PROFILE_METADATA;
// this list is derived (legacy host-owned read surface).
export const MOBILE_CORE_PLUGINS: readonly string[] =
  selectCorePluginsByProfile((entry) => entry.mobileCore);

/**
 * Model-provider plugins that are statically imported by the mobile runtime and
 * may survive the final mobile allow-list when their env/config gates select
 * them. Keep this beside MOBILE_CORE_PLUGINS so the mobile bundle contract has
 * one owner.
 */
export const MOBILE_MODEL_PROVIDER_PLUGINS: readonly string[] = [
  "@elizaos/plugin-anthropic",
  "@elizaos/plugin-openai",
  "@elizaos/plugin-ollama",
  "@elizaos/plugin-elizacloud",
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
// View-plugin rationale (declared via `viewEveryPlatform` in the metadata):
// - plugin-inbox: registered on mobile so its home tile resolves + the /inbox
//   view appears in /api/views.
// - plugin-app-control: provides the VIEWS navigation action + view-switch
//   evaluators ("open settings" / "go to my calendar"); its view-nav path needs
//   no services, and the app-launch/worker-host services stay idle on mobile.
// Derived from CORE_PLUGIN_PROFILE_METADATA (legacy host-owned read surface).
export const MOBILE_VIEW_PLUGINS: readonly string[] =
  selectCorePluginsByProfile((entry) => entry.viewEveryPlatform);

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
// Derived from CORE_PLUGIN_PROFILE_METADATA (`aospCore`) — legacy host-owned
// read surface; declare new AOSP overlay app plugins via the metadata table.
export const ELIZAOS_ANDROID_CORE_PLUGINS: readonly string[] =
  selectCorePluginsByProfile((entry) => entry.aospCore);

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
// Derived from CORE_PLUGIN_PROFILE_METADATA (`aospTerminal`), ordered by the
// declared `aospTerminalOrder` so the historical shell -> coding-tools ->
// agent-orchestrator load order is preserved even though agent-orchestrator
// leads the (table-ordered) desktop list. Legacy host-owned read surface;
// declare new AOSP terminal plugins via the metadata table.
export const ELIZAOS_ANDROID_TERMINAL_PLUGINS: readonly string[] =
  CORE_PLUGIN_PROFILE_METADATA.filter((entry) => entry.aospTerminal)
    .slice()
    .sort((a, b) => (a.aospTerminalOrder ?? 0) - (b.aospTerminalOrder ?? 0))
    .map((entry) => entry.plugin);

/** Core plugins that should always be loaded. collectPluginNames() seeds from this list only. */
export const CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql", // database adapter — required
  "@elizaos/plugin-local-inference", // local Eliza-1 inference (text + embeddings + voice) — required for memory + on-device generation
  // @elizaos/plugin-form — standalone form plugin; load via plugin registry/config
  // @elizaos/plugin-agent-orchestrator — opt-in via ELIZA_AGENT_ORCHESTRATOR (Eliza app enables by default)
  // Recurring work uses runtime TaskService + triggers (no @elizaos/plugin-cron).
  "@elizaos/plugin-app-control", // launch, close, and list running Eliza apps from agent chat
  "@elizaos/plugin-cloud-apps", // Eliza Cloud Apps: LIST_CLOUD_APPS / GET_APP + CLOUD_APPS provider, plus CREATE_APP / DEPLOY_APP (READY+reachability completion gate) / GET_APP_DEPLOY_STATUS / DELETE_APP (two-phase confirm) + deploy-success facts cache. Reaches local/native + Discord/Telegram via the shared pipeline. Cloud-hosted agents add this separately via agent-loader, gated behind CLOUD_APPS_PLUGIN_ENABLED.
  "@elizaos/plugin-native-filesystem", // mobile-safe FILE target=device via Capacitor on iOS/Android, Node fs/promises rooted under resolveStateDir()/workspace on desktop/AOSP
  "@elizaos/plugin-shell", // shell service, approvals, and history provider
  "@elizaos/plugin-coding-tools", // native FILE/SHELL/WORKTREE coding tools (desktop-only
  "@elizaos/plugin-agent-skills", // skill execution and marketplace runtime
  "@elizaos/plugin-commands", // slash command handling (skills auto-register as /commands)
  "@elizaos/plugin-browser", // Browser workspace and Chrome/Safari companion bridge.
  "@elizaos/plugin-scheduling", // always-loaded ScheduledTask runtime primitive (runner host + REST surface + seed registry); personal-assistant enriches it when present
  // Built-in runtime capabilities (no longer external plugins):
  // - experience, todos, personality: advanced capabilities (advancedCapabilities: true)
  // - form: standalone @elizaos/plugin-form
  // - trust: core capability (enableTrust: true)
  // - secrets (SECRETS): core capability (enableSecretsManager: true)
  // - plugin-manager: core capability (enablePluginManager: true)
  // - knowledge, relationships, trajectories: native features
];

/**
 * Minimal plugin set for a dedicated, chat-only cloud agent (#8434). A dedicated
 * agent boots a full local AgentRuntime inside its container; the default
 * CORE_PLUGINS set carries heavy coding/automation surfaces (shell, coding-tools,
 * browser, the orchestrator, gitpathologist) that a purely conversational agent
 * never uses and that dominate its cold-boot time. Opt in per agent by setting
 * `ELIZA_PLUGIN_SET=lean-chat` in the container environment.
 *
 * Browser is intentionally excluded — it stays OFF for lean chat until the
 * browser surface is production-ready. This set is for dedicated agents only;
 * cloud-PROXIED (shared-runtime) agents boot zero plugins by construction.
 */
export const LEAN_CHAT_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql", // database adapter — required
  "@elizaos/plugin-local-inference", // text + embeddings + voice — required for memory + generation
  "@elizaos/plugin-app-control", // VIEWS navigation in the app chat surface
  "@elizaos/plugin-native-filesystem", // mobile-safe FILE target
  "@elizaos/plugin-agent-skills", // skill execution + enabled-skills provider
  "@elizaos/plugin-commands", // slash commands
];

/**
 * Heavy surfaces force-excluded under `ELIZA_PLUGIN_SET=lean-chat` even when some
 * other gate would otherwise add them (ELIZA_AGENT_ORCHESTRATOR, gitpathologist
 * .git auto-detect, config allow-lists). Guarantees a lean chat agent stays lean.
 * Browser is listed per the "browser disabled until ready" decision.
 */
export const LEAN_CHAT_EXCLUDED_PLUGINS: readonly string[] = [
  "@elizaos/plugin-shell",
  "@elizaos/plugin-coding-tools",
  "@elizaos/plugin-browser",
  "agent-orchestrator",
  "@elizaos/plugin-agent-orchestrator",
  "@elizaos/plugin-gitpathologist",
  // Cloud chat agents route models to Eliza Cloud (plugin-elizacloud), which
  // serves TEXT_EMBEDDING via the fast 1536-dim cloud endpoint. plugin-local-
  // inference otherwise wins the TEXT_EMBEDDING registration with an on-device
  // gte-small GGUF that runs on the container's (contended) CPU — measured at
  // 1.5–98s per batch and ~30s/turn on a dedicated agent, plus a 384↔1536
  // dimension mismatch that drops every memory insert. A cloud agent has no
  // local GPU and no reason to run local inference, so exclude it and let the
  // cloud embedding handler serve TEXT_EMBEDDING.
  "@elizaos/plugin-local-inference",
  // Cloud agent containers are Steward-provisioned (ELIZA_CLOUD_PROVISIONED=1 +
  // STEWARD_API_URL + STEWARD_AGENT_TOKEN), which trips plugin-wallet's
  // auto-enable manifest (hasCloudStewardWallet) on EVERY agent — even a purely
  // conversational one. Its evmWalletProvider then warms on-chain balances at
  // boot (getBalance(mainnet)+getBalance(base)), each a 3s RPC that times out
  // against the cloud RPC and falls back to a public node — ~6s of dead boot
  // time and recurring RPC noise for an agent that never reads a balance.
  // plugin-workflow auto-enables for the same structural reason with no chat
  // value. Auto-enable runs before the lean-chat force-drop (plugin-collector),
  // so listing them here is what actually keeps them out of a lean chat agent.
  "@elizaos/plugin-wallet",
  "@elizaos/plugin-workflow",
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
  "@elizaos/plugin-birdclaw", // birdclaw.sh local-first Twitter/X archive (auto-on when the birdclaw CLI/data root exists, gate ELIZA_BIRDCLAW)
  // "@elizaos/plugin-directives", // directive processing remains opt-in
  // "@elizaos/plugin-mcp", // MCP protocol support remains opt-in
  // @elizaos/plugin-scheduling is now an always-loaded CORE + MOBILE plugin.
  // todos: now built-in as advanced capability (advancedCapabilities: true)
];
