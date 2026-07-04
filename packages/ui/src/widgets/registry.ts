/**
 * Plugin widget registry.
 *
 * Maintains a static map of plugin widget React components (bundled plugins)
 * and resolves widgets for a given slot based on plugin state.
 *
 * Third-party plugins without bundled React components can provide a `uiSpec`
 * in their widget declaration, which gets rendered by `UiRenderer` via the
 * `WidgetHost` component.
 */

import type { PluginInfo } from "../api/client-types-config";
import { buildDefaultHomeWidgetDeclarations } from "./default-home-widget-sink-optins";
import {
  getWidgetComponent,
  markWidgetRegistryChanged,
  registerBuiltinWidgets,
  registerWidgetComponent,
} from "./registry-store";
import type { PluginWidgetDeclaration, WidgetProps, WidgetSlot } from "./types";

type DefaultHomeWidgetSink = NonNullable<
  PluginWidgetDeclaration["defaultWidget"]
>;

export {
  getWidgetComponent,
  getWidgetRegistryVersion,
  registerBuiltinWidgets,
  registerWidgetComponent,
  subscribeWidgetRegistry,
} from "./registry-store";

// -- Bundled widget component imports ----------------------------------------

import { MusicLibraryCharacterWidget } from "../components/character/MusicLibraryCharacterWidget";
import { AgentActivityWidget } from "../components/chat/widgets/agent-activity";
import { AGENT_ORCHESTRATOR_PLUGIN_WIDGETS } from "../components/chat/widgets/agent-orchestrator";
import { AGENT_PROVISIONING_HOME_WIDGET } from "../components/chat/widgets/agent-provisioning";
import { AutomationsWidget } from "../components/chat/widgets/automations";
import { BROWSER_STATUS_WIDGET } from "../components/chat/widgets/browser-status.helpers";
import { CALENDAR_HOME_WIDGET } from "../components/chat/widgets/calendar-upcoming";
import { FINANCES_HOME_WIDGET } from "../components/chat/widgets/finances-alerts";
import { FTU_WELCOME_HOME_WIDGET } from "../components/chat/widgets/ftu-welcome";
import { GOALS_HOME_WIDGET } from "../components/chat/widgets/goals-attention";
import { HEALTH_HOME_WIDGET } from "../components/chat/widgets/health-sleep";
import { INBOX_HOME_WIDGET } from "../components/chat/widgets/inbox-unread";
import { MODEL_DOWNLOAD_HOME_WIDGET } from "../components/chat/widgets/model-download";
import { MUSIC_PLAYER_WIDGET } from "../components/chat/widgets/music-player.helpers";
import { NEEDS_ATTENTION_HOME_WIDGET } from "../components/chat/widgets/needs-attention";
import { NotificationsWidget } from "../components/chat/widgets/notifications";
import { RELATIONSHIPS_HOME_WIDGET } from "../components/chat/widgets/relationships-attention";
import { TODO_PLUGIN_WIDGETS } from "../components/chat/widgets/todo";
import { WalletBalanceWidget } from "../components/chat/widgets/wallet-balance";

// -- Seed bundled widgets into the registry ----------------------------------

registerBuiltinWidgets(AGENT_ORCHESTRATOR_PLUGIN_WIDGETS);
registerBuiltinWidgets([BROWSER_STATUS_WIDGET, MUSIC_PLAYER_WIDGET]);
// Register the todo widget's component so it can be declared on the home slot
// (#9143 per-plugin breadth — the todo plugin's frontpage opt-in). Idempotent
// with the plugin's own runtime registration.
registerBuiltinWidgets(TODO_PLUGIN_WIDGETS);
registerWidgetComponent(
  "music-library",
  "music-library.playlists",
  MusicLibraryCharacterWidget,
);
// Notifications is a core feature (no separate plugin), so its frontpage widget
// always resolves (its declaration carries `visibility: "always"`). (#9143)
registerWidgetComponent(
  "notifications",
  "notifications.recent",
  NotificationsWidget,
);
// Curated home-grid widgets backed by core API surfaces (conversations, agent
// activity, wallet, running workflows). Each renders populated data, a
// connected-but-empty state, or self-hides — always-visible so the home grid is
// populated even before the runtime plugin snapshot arrives. The connector
// status strip and discord recent tiles were intentionally dropped from the
// home surface: they surfaced connector warn/error chips and a "Connect Discord"
// affordance that crowded the naked home grid with setup noise.
registerWidgetComponent("feed", "feed.agent-activity", AgentActivityWidget);
registerWidgetComponent("wallet", "wallet.balance", WalletBalanceWidget);
// Running-automations tile (ITEM 5): backed by the core GET /api/automations
// surface (system automations + active user workflows), so it is always-visible
// and self-hides when nothing is running. The widget kind stays "workflow" —
// it is the backend widget-registration key, not a user-facing label.
registerWidgetComponent("workflow", "workflow.running", AutomationsWidget);
// Setup-progress home tiles: the local model download (LOCAL mode, backed by the
// local-inference hub) and the cloud-agent provisioning handoff (CLOUD mode,
// backed by the cloud handoff phase event). Neither is a loadable plugin, so
// both are always-visible and self-hide when there's nothing in flight — the
// recommended model finishes downloading, or the dedicated cloud agent attaches.
registerWidgetComponent(
  MODEL_DOWNLOAD_HOME_WIDGET.pluginId,
  MODEL_DOWNLOAD_HOME_WIDGET.id,
  MODEL_DOWNLOAD_HOME_WIDGET.Component,
);
registerWidgetComponent(
  AGENT_PROVISIONING_HOME_WIDGET.pluginId,
  AGENT_PROVISIONING_HOME_WIDGET.id,
  AGENT_PROVISIONING_HOME_WIDGET.Component,
);
// First-time-user welcome card (#9959): a core FTU surface, not a loadable
// plugin, so it's always-visible and self-retires via the sunset lifecycle once
// the user engages or dismisses it.
registerWidgetComponent(
  FTU_WELCOME_HOME_WIDGET.pluginId,
  FTU_WELCOME_HOME_WIDGET.id,
  FTU_WELCOME_HOME_WIDGET.Component,
);

// Per-plugin frontpage widgets (#9143): each surfaces a compact, attention-
// ranked slice of its plugin's own state on the home grid (a step up from the
// generic default-widget sinks), self-hides when empty, and self-publishes a
// home-attention signal so it floats up on its own data urgency. They resolve
// only when the plugin is enabled+active in the runtime snapshot.
for (const w of [
  CALENDAR_HOME_WIDGET,
  GOALS_HOME_WIDGET,
  FINANCES_HOME_WIDGET,
  HEALTH_HOME_WIDGET,
  RELATIONSHIPS_HOME_WIDGET,
  INBOX_HOME_WIDGET,
  NEEDS_ATTENTION_HOME_WIDGET,
]) {
  registerWidgetComponent(w.pluginId, w.id, w.Component);
}

// App-manifest plugins that do not ship an owned home card opt into one of the
// shared default sinks. The opt-in rows now live in the co-located, explicitly-
// marked legacy host-owned fallback table
// (`LEGACY_DEFAULT_HOME_WIDGET_SINK_OPTINS`) instead of a second hand-maintained
// declaration literal in this trunk (#12089 item 35). A plugin migrating to its
// own `Plugin.widgets` declaration drops its row there — no edit here — and a
// plugin-owned/server declaration wins over its legacy fallback row.
const APP_HOME_DEFAULT_WIDGET_DECLARATIONS: PluginWidgetDeclaration[] =
  buildDefaultHomeWidgetDeclarations();

/**
 * Public API for plugins outside app-core to append widget declarations to the
 * built-in fallback list. Declarations appear in the sidebar when the runtime
 * plugin snapshot isn't available or when the plugin is in the fallback set.
 */
export function registerBuiltinWidgetDeclarations(
  declarations: ReadonlyArray<PluginWidgetDeclaration>,
  options?: { fallbackPluginIds?: ReadonlyArray<string> },
): void {
  for (const decl of declarations) {
    BUILTIN_WIDGET_DECLARATIONS.push(decl);
  }
  if (options?.fallbackPluginIds) {
    for (const id of options.fallbackPluginIds) {
      EXTERNAL_FALLBACK_PLUGIN_IDS.add(id);
    }
  }
  // Wake any mounted home/sidebar host so a declaration registered after the
  // slot was first resolved (plugin modules load on the idle path) re-resolves
  // instead of being dropped until the next plugin-snapshot change.
  markWidgetRegistryChanged();
}

// -- Built-in widget declarations --------------------------------------------
// These are the widget declarations for bundled plugins. They mirror what
// the server will eventually provide via GET /api/plugins, but are also
// available client-side for zero-config rendering.

export const BUILTIN_WIDGET_DECLARATIONS: PluginWidgetDeclaration[] = [
  // First-time-user welcome (#9959) — guided cold-start home: greeting + tappable
  // "try saying…" chips. Ranks at the top for a cold user (welcome weight, below
  // approval/escalation/blocked) and retires permanently once the user engages or
  // dismisses it (sunset lifecycle).
  {
    id: FTU_WELCOME_HOME_WIDGET.id,
    pluginId: FTU_WELCOME_HOME_WIDGET.pluginId,
    slot: "home",
    label: "Welcome",
    icon: "Sparkles",
    order: FTU_WELCOME_HOME_WIDGET.order,
    defaultEnabled: true,
    // Core FTU surface, not a loadable plugin — always-visible, self-retires.
    visibility: "always",
    signalKinds: FTU_WELCOME_HOME_WIDGET.signalKinds,
    size: FTU_WELCOME_HOME_WIDGET.size,
    sunset: FTU_WELCOME_HOME_WIDGET.sunset,
  },
  // Notifications — the first-class "default" frontpage widget (#9143).
  {
    id: "notifications.recent",
    pluginId: "notifications",
    slot: "home",
    label: "Notifications",
    icon: "Bell",
    order: 50,
    defaultEnabled: true,
    // Core NotificationService feature, not a loadable plugin — always-visible.
    visibility: "always",
    // Boosted by any notification; urgent ones map to escalation-level weight.
    signalKinds: ["notification", "approval", "escalation"],
  },
  // The standalone Recent-conversations tile was removed (#10697) — it
  // duplicated the always-present chat overlay. Follow-up-worthy messages now
  // surface as `category: "message"` notifications in the notification rail.
  // Agent Orchestrator — app runs
  {
    id: "agent-orchestrator.apps",
    pluginId: "agent-orchestrator",
    slot: "chat-sidebar",
    label: "Apps",
    icon: "Activity",
    order: 150,
    defaultEnabled: true,
    visibility: "fallback",
  },
  // Agent Orchestrator — activity
  {
    id: "agent-orchestrator.activity",
    pluginId: "agent-orchestrator",
    slot: "chat-sidebar",
    label: "Activity",
    icon: "Activity",
    order: 300,
    defaultEnabled: true,
    visibility: "fallback",
  },
  // Agent Orchestrator — activity surfaced on the home/frontpage too (#9143).
  // Same pluginId+id reuses the registered component; the `home` slot is a
  // separate resolveWidgetsForSlot pass, so this doesn't disturb the sidebar.
  {
    id: "agent-orchestrator.activity",
    pluginId: "agent-orchestrator",
    slot: "home",
    label: "Activity",
    icon: "Activity",
    order: 100,
    defaultEnabled: true,
    visibility: "fallback",
    // The orchestrator activity card bubbles up when a run is blocked, escalated,
    // or busy — the highest-attention home signals.
    signalKinds: ["blocked", "escalation", "workflow", "activity"],
  },
  // Agent Orchestrator — running app instances on the home (#9143). Distinct
  // from the launcher icons (which open views): this lists live app runs.
  // Reuses the registered AppRunsWidget component (self-contained data).
  {
    id: "agent-orchestrator.apps",
    pluginId: "agent-orchestrator",
    slot: "home",
    label: "Apps",
    icon: "LayoutGrid",
    order: 70,
    defaultEnabled: true,
    visibility: "fallback",
    signalKinds: ["activity"],
  },
  // Todos — the todo plugin's frontpage widget (#9143 per-plugin breadth).
  {
    id: "todo.items",
    pluginId: "todo",
    slot: "home",
    label: "Todos",
    icon: "ListTodo",
    order: 80,
    defaultEnabled: true,
    // Renders from the workbench store, so it shows even before the runtime
    // plugin snapshot lists the plugin (#9143). Declaration-driven `fallback`
    // replaces the hardcoded `"todo"` allow-set entry that used to drift out of
    // sync with the `todos` app-manifest plugin id (#12090 item 9).
    visibility: "fallback",
    signalKinds: ["reminder", "check-in", "nudge"],
  },
  // -- Per-plugin real-data frontpage widgets (#9143) ------------------------
  // These carry their own bundled component (registered above) showing a
  // compact, attention-ranked slice of the plugin's state, replacing the
  // generic default-widget sinks for plugins that warrant a richer card. Each
  // self-hides when empty and self-publishes a home-attention signal.
  {
    id: INBOX_HOME_WIDGET.id,
    pluginId: INBOX_HOME_WIDGET.pluginId,
    slot: "home",
    label: "Inbox",
    icon: "Inbox",
    order: INBOX_HOME_WIDGET.order,
    defaultEnabled: true,
    signalKinds: INBOX_HOME_WIDGET.signalKinds,
  },
  // Needs response — the canonical "actions requiring your response" card
  // (#9449). Backed by the core ApprovalService (GET /api/approvals), not a
  // loadable plugin, so it is always-visible (declaration `visibility:
  // "always"`) and self-hides when nothing is pending. Floats up at
  // approval/escalation weight on its own data.
  {
    id: NEEDS_ATTENTION_HOME_WIDGET.id,
    pluginId: NEEDS_ATTENTION_HOME_WIDGET.pluginId,
    slot: "home",
    label: "Needs response",
    icon: "CircleHelp",
    order: NEEDS_ATTENTION_HOME_WIDGET.order,
    defaultEnabled: true,
    // Backed by the core ApprovalService, not a loadable plugin (#9449).
    visibility: "always",
    signalKinds: NEEDS_ATTENTION_HOME_WIDGET.signalKinds,
  },
  {
    id: RELATIONSHIPS_HOME_WIDGET.id,
    pluginId: RELATIONSHIPS_HOME_WIDGET.pluginId,
    slot: "home",
    label: "Relationships",
    icon: "Users",
    order: RELATIONSHIPS_HOME_WIDGET.order,
    defaultEnabled: true,
    // Core API-backed home tile; renders regardless of snapshot, self-hides
    // when empty. A `present + disabled` snapshot entry still hides it.
    visibility: "always",
    signalKinds: RELATIONSHIPS_HOME_WIDGET.signalKinds,
    size: { cols: 2, rows: 1 },
  },
  {
    id: CALENDAR_HOME_WIDGET.id,
    pluginId: CALENDAR_HOME_WIDGET.pluginId,
    slot: "home",
    label: "Upcoming",
    icon: "Clock",
    order: CALENDAR_HOME_WIDGET.order,
    defaultEnabled: true,
    // Core API-backed home tile; renders regardless of snapshot, self-hides
    // when empty. A `present + disabled` snapshot entry still hides it.
    visibility: "always",
    signalKinds: CALENDAR_HOME_WIDGET.signalKinds,
    // Own full-width row; the widget renders only when an event exists.
    size: { cols: 4, rows: 1 },
  },
  // -- Curated home-grid widgets (4-col grid `size`) -------------------------
  // Recent conversations, agent activity, wallet, and running workflows. Each is
  // backed by a core API surface and renders populated data, a connected-but-
  // empty state, or self-hides when empty.
  // Local model download (LOCAL mode): surfaces the recommended on-device text
  // model downloading — queued / %-progress / loading / failed-with-retry — so a
  // fresh "This device" agent shows progress instead of a dead chat. Self-hides
  // when no local model is required (cloud/remote) or every slot is ready.
  {
    id: MODEL_DOWNLOAD_HOME_WIDGET.id,
    pluginId: MODEL_DOWNLOAD_HOME_WIDGET.pluginId,
    slot: "home",
    label: "Local model",
    icon: "Download",
    order: MODEL_DOWNLOAD_HOME_WIDGET.order,
    defaultEnabled: true,
    // Setup-progress tile backed by the local-inference hub, not a loadable
    // plugin — always-visible, self-hides once the model is ready.
    visibility: "always",
    signalKinds: MODEL_DOWNLOAD_HOME_WIDGET.signalKinds,
    // Full-width, double-height: model download/activation is the one thing
    // standing between a fresh local agent and its first reply, so it owns a
    // whole row with a real progress bar (it self-hides once ready).
    size: { cols: 4, rows: 2 },
  },
  // Cloud-agent provisioning (CLOUD mode): while a freshly-provisioned dedicated
  // cloud agent boots, the user already chats on the shared agent and this tile
  // shows the background setup plus a Retry control. Self-hides once the
  // dedicated agent attaches or for a pure-local runtime.
  {
    id: AGENT_PROVISIONING_HOME_WIDGET.id,
    pluginId: AGENT_PROVISIONING_HOME_WIDGET.pluginId,
    slot: "home",
    label: "Cloud agent",
    icon: "CloudCog",
    order: AGENT_PROVISIONING_HOME_WIDGET.order,
    defaultEnabled: true,
    // Setup-progress tile backed by the cloud handoff phase, not a loadable
    // plugin — always-visible, self-hides once the dedicated agent attaches.
    visibility: "always",
    signalKinds: AGENT_PROVISIONING_HOME_WIDGET.signalKinds,
    size: { cols: 2, rows: 1 },
  },
  {
    id: "feed.agent-activity",
    pluginId: "feed",
    slot: "home",
    label: "Agent activity",
    icon: "Activity",
    order: 65,
    defaultEnabled: true,
    // Core API-backed home tile; renders regardless of snapshot, self-hides
    // when empty.
    visibility: "always",
    signalKinds: ["workflow", "activity"],
    size: { cols: 2, rows: 1 },
  },
  {
    id: "wallet.balance",
    pluginId: "wallet",
    slot: "home",
    label: "Wallet",
    icon: "Wallet",
    order: 140,
    defaultEnabled: true,
    // Core app-core surface, not a separately loadable plugin — always-visible.
    visibility: "always",
    signalKinds: ["activity"],
    size: { cols: 2, rows: 1 },
  },
  // Running tasks tile — surfaces the agent's currently-running tasks: system
  // automations + active user workflows (GET /api/automations) merged with
  // boot-seeded LifeOps scheduled tasks (GET /api/lifeops/scheduled-tasks).
  // Self-hides when nothing is running.
  {
    id: "workflow.running",
    pluginId: "workflow",
    slot: "home",
    label: "Tasks",
    icon: "Workflow",
    order: 130,
    defaultEnabled: true,
    // Backed by GET /api/automations; always-visible, self-hides when nothing
    // is running. A `present + disabled` snapshot entry still hides it.
    visibility: "always",
    signalKinds: ["workflow", "activity"],
    size: { cols: 2, rows: 1 },
  },
  {
    id: GOALS_HOME_WIDGET.id,
    pluginId: GOALS_HOME_WIDGET.pluginId,
    slot: "home",
    label: "Goals",
    icon: "Target",
    order: GOALS_HOME_WIDGET.order,
    defaultEnabled: true,
    signalKinds: GOALS_HOME_WIDGET.signalKinds,
  },
  {
    id: FINANCES_HOME_WIDGET.id,
    pluginId: FINANCES_HOME_WIDGET.pluginId,
    slot: "home",
    label: "Bills & Balance",
    icon: "Wallet",
    order: FINANCES_HOME_WIDGET.order,
    defaultEnabled: true,
    signalKinds: FINANCES_HOME_WIDGET.signalKinds,
  },
  {
    id: HEALTH_HOME_WIDGET.id,
    pluginId: HEALTH_HOME_WIDGET.pluginId,
    slot: "home",
    label: "Sleep",
    icon: "Moon",
    order: HEALTH_HOME_WIDGET.order,
    defaultEnabled: true,
    signalKinds: HEALTH_HOME_WIDGET.signalKinds,
  },
  // App-manifest plugins that do not ship an owned home card opt into one of
  // the shared default sinks (#9143). These declarations are contract entries:
  // they prove the plugin participates in the frontpage widget system, while
  // the shared notifications/messages/activity cards above remain the single
  // visible aggregate surfaces for their sink kind.
  ...APP_HOME_DEFAULT_WIDGET_DECLARATIONS,
  // Browser workspace status — surfaces /browser state in the right rail.
  {
    id: BROWSER_STATUS_WIDGET.id,
    pluginId: BROWSER_STATUS_WIDGET.pluginId,
    slot: "chat-sidebar",
    label: "Browser",
    icon: "Globe",
    order: BROWSER_STATUS_WIDGET.order,
    defaultEnabled: BROWSER_STATUS_WIDGET.defaultEnabled,
    // Core app-core surface (browser-workspace), not a loadable plugin — shows
    // even when the snapshot omits it.
    visibility: "fallback",
  },
  {
    id: MUSIC_PLAYER_WIDGET.id,
    pluginId: MUSIC_PLAYER_WIDGET.pluginId,
    slot: "chat-sidebar",
    label: "Music",
    icon: "Music",
    order: MUSIC_PLAYER_WIDGET.order,
    defaultEnabled: MUSIC_PLAYER_WIDGET.defaultEnabled,
    // Core playback surface, not a loadable plugin — always-visible.
    visibility: "always",
  },
  {
    id: "music-library.playlists",
    pluginId: "music-library",
    slot: "character",
    label: "Music Library",
    icon: "ListMusic",
    order: 250,
    defaultEnabled: true,
  },
];

// -- Resolution --------------------------------------------------------------

/** Minimal plugin state needed for widget resolution. */
export type WidgetPluginState = Pick<PluginInfo, "id" | "enabled" | "isActive">;

/**
 * Supplementary `fallback`-class plugin ids contributed by third-party callers via
 * `registerBuiltinWidgetDeclarations({ fallbackPluginIds })`. Built-in
 * declarations no longer rely on a hardcoded id set — each carries its own
 * `visibility` flag (#12090 item 9) so a declaration cannot drift out of the
 * allow set when its plugin id changes (e.g. the historical `todo`/`todos`
 * split). This set only extends `fallback` behavior for declarations that don't
 * (or can't) set the flag themselves.
 */
const EXTERNAL_FALLBACK_PLUGIN_IDS = new Set<string>();

/**
 * Visibility class for a built-in declaration, derived from its own
 * `visibility` field with a back-compat fallback to the third-party allow set.
 * Server-provided declarations are always snapshot-gated.
 */
export function widgetVisibilityClass(
  declaration: PluginWidgetDeclaration,
  source: WidgetDeclarationSource = "builtin",
): "always" | "fallback" | "snapshot" {
  if (source !== "builtin") return "snapshot";
  if (declaration.visibility) return declaration.visibility;
  if (EXTERNAL_FALLBACK_PLUGIN_IDS.has(declaration.pluginId)) return "fallback";
  return "snapshot";
}

export interface ResolvedWidget {
  declaration: PluginWidgetDeclaration;
  Component: React.ComponentType<WidgetProps> | null;
  defaultWidgetSink?: DefaultHomeWidgetSink;
}

type WidgetDeclarationSource = "builtin" | "server";

function isWidgetEnabled(
  declaration: PluginWidgetDeclaration,
  plugins: readonly WidgetPluginState[],
  source: WidgetDeclarationSource,
): boolean {
  if (declaration.defaultEnabled === false) return false;

  const visibility = widgetVisibilityClass(declaration, source);

  // Some always-visible ids (calendar / relationships / workflow) ARE backed by
  // real loadable plugins, so an explicit "present + disabled" snapshot entry
  // must still hide them — the always/fallback short-circuits are for core
  // surfaces with NO plugin package (welcome/notifications/needs-attention/
  // feed/wallet/…), which never appear in the snapshot and so pass this check
  // untouched.
  const snapshotPlugin = plugins.find((p) => p.id === declaration.pluginId);
  const explicitlyDisabled =
    snapshotPlugin != null &&
    snapshotPlugin.enabled === false &&
    snapshotPlugin.isActive !== true;
  if (explicitlyDisabled) return false;

  // `always`: render regardless of the snapshot (already gated above by the
  // explicit present+disabled hide).
  if (visibility === "always") return true;

  // `fallback`: render when the snapshot is empty OR omits the plugin (a
  // store/compat-backed surface), but a present+active/enabled entry is honored
  // like any snapshot-gated widget.
  if (visibility === "fallback") {
    if (plugins.length === 0 || snapshotPlugin == null) return true;
    return snapshotPlugin.isActive === true || snapshotPlugin.enabled !== false;
  }

  // Server-provided declarations pre-date the `visibility` flag. Preserve the
  // pre-refactor semantics exactly: an EMPTY snapshot leaves them enabled (the
  // declaration only exists because its plugin sent it, and may have arrived
  // before the snapshot entry — a race we don't want to hide it), but a
  // NON-empty snapshot that OMITS the plugin means the plugin is genuinely
  // absent, so hide it (the old `!plugin -> false` branch).
  if (source === "server") {
    if (plugins.length === 0) return true;
    if (snapshotPlugin == null) return false;
    return snapshotPlugin.isActive === true || snapshotPlugin.enabled !== false;
  }

  // Built-in `snapshot` (default): visible only when present + enabled/active.
  if (plugins.length === 0) return false;
  if (snapshotPlugin == null) return false;
  return snapshotPlugin.isActive === true || snapshotPlugin.enabled !== false;
}

/**
 * Resolve all enabled widgets for a slot.
 *
 * Merges built-in declarations with any server-provided declarations
 * (from PluginInfo.widgets), deduplicating by declaration ID.
 */
/**
 * Maps a declaration's `defaultWidget` opt-in (#9143) to the registered shared
 * frontpage sink component (already registered above via
 * `registerWidgetComponent`). A `home`-slot plugin with no own component renders
 * one of these shared widgets instead of shipping its own.
 */
export const DEFAULT_WIDGET_SINK_COMPONENT: Readonly<
  Record<DefaultHomeWidgetSink, { pluginId: string; id: string }>
> = {
  notifications: { pluginId: "notifications", id: "notifications.recent" },
  // The `messages` sink now folds into the notification rail (#10697) — the
  // standalone Messages widget was removed as redundant with the chat overlay,
  // so a plugin declaring `defaultWidget: "messages"` resolves to notifications.
  messages: { pluginId: "notifications", id: "notifications.recent" },
  activity: {
    pluginId: "agent-orchestrator",
    id: "agent-orchestrator.activity",
  },
};

export function resolveWidgetsForSlot(
  slot: WidgetSlot,
  plugins: readonly WidgetPluginState[],
  serverDeclarations?: readonly PluginWidgetDeclaration[],
): ResolvedWidget[] {
  // Merge: server declarations override built-in by id
  const declarationMap = new Map<
    string,
    {
      declaration: PluginWidgetDeclaration;
      source: WidgetDeclarationSource;
    }
  >();

  for (const decl of BUILTIN_WIDGET_DECLARATIONS) {
    if (decl.slot === slot) {
      declarationMap.set(`${decl.pluginId}/${decl.id}`, {
        declaration: decl,
        source: "builtin",
      });
    }
  }

  if (serverDeclarations) {
    for (const decl of serverDeclarations) {
      if (decl.slot === slot) {
        declarationMap.set(`${decl.pluginId}/${decl.id}`, {
          declaration: decl,
          source: "server",
        });
      }
    }
  }

  // Home-slot plugins that resolve to their OWN renderable home card (a bundled
  // component or a `uiSpec`) — used to suppress a plugin's generic default-sink
  // fallback row once it ships a real card, so a plugin migrating its opt-in
  // onto its own `Plugin.widgets` doesn't render two home tiles (the owned card
  // AND the stale `.default-home` sink) side by side.
  //
  // Only a card THIS host can actually render counts: a declaration with no
  // registered component and no `uiSpec` (e.g. a remote/componentExport-only
  // server declaration this build can't render) is dropped downstream by the
  // `Component || uiSpec` gate, so it must NOT suppress the shared sink — doing
  // so would leave the plugin with no home tile at all (a regression vs. the
  // pre-refactor behavior, where the sink still rendered).
  const pluginsWithOwnHomeCard = new Set<string>();
  if (slot === "home") {
    for (const { declaration } of declarationMap.values()) {
      if (declaration.slot !== "home") continue;
      const rendersViaOwnCard =
        !!declaration.uiSpec ||
        !!getWidgetComponent(declaration.pluginId, declaration.id);
      if (rendersViaOwnCard) {
        pluginsWithOwnHomeCard.add(declaration.pluginId);
      }
    }
  }

  const results: ResolvedWidget[] = [];

  for (const { declaration, source } of declarationMap.values()) {
    if (!isWidgetEnabled(declaration, plugins, source)) continue;

    let Component = getWidgetComponent(declaration.pluginId, declaration.id);
    let defaultWidgetSink: DefaultHomeWidgetSink | undefined;

    // Home-slot opt-in sink (#9143): a plugin with no own component but a
    // `defaultWidget` renders the shared sink component for that kind. Borrows
    // only the component — the declaration keeps its own pluginId/id/order so
    // ranking + dedupe treat it as distinct. Fallback-only: never overrides an
    // own component, never fires off the home slot.
    if (
      !Component &&
      declaration.slot === "home" &&
      declaration.defaultWidget
    ) {
      // Suppress the generic default-sink fallback for a plugin that already
      // resolves to its own renderable home card. This is the migration guard:
      // the legacy `.default-home` sink row stands in ONLY while the plugin
      // ships no real card, so it must not double up with an owned card under a
      // different id. Scope is deliberately narrow:
      //   - `source === "builtin"`: only the built-in legacy fallback rows are
      //     suppressible. A SERVER-provided sink declaration is an intentional
      //     plugin choice (a plugin may ship an owned card AND a separate shared
      //     sink widget) and must still render.
      //   - `!declaration.uiSpec`: a `uiSpec`-carrying declaration is a real card
      //     that renders its own spec below, never the sink-only fallback.
      if (
        source === "builtin" &&
        !declaration.uiSpec &&
        pluginsWithOwnHomeCard.has(declaration.pluginId)
      ) {
        continue;
      }
      const sink = DEFAULT_WIDGET_SINK_COMPONENT[declaration.defaultWidget];
      Component = getWidgetComponent(sink.pluginId, sink.id);
      if (Component) {
        defaultWidgetSink = declaration.defaultWidget;
      }
    }

    // Include if we have a React component OR a uiSpec fallback
    if (Component || declaration.uiSpec) {
      results.push({
        declaration,
        Component: Component ?? null,
        ...(defaultWidgetSink ? { defaultWidgetSink } : {}),
      });
    }
  }

  results.sort(
    (a, b) => (a.declaration.order ?? 100) - (b.declaration.order ?? 100),
  );

  return results;
}
