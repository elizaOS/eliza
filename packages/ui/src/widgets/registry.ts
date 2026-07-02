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
import {
  getWidgetComponent,
  registerBuiltinWidgets,
  registerWidgetComponent,
} from "./registry-store";
import type { PluginWidgetDeclaration, WidgetProps, WidgetSlot } from "./types";

type DefaultHomeWidgetSink = NonNullable<
  PluginWidgetDeclaration["defaultWidget"]
>;

export {
  getWidgetComponent,
  registerBuiltinWidgets,
  registerWidgetComponent,
} from "./registry-store";

// -- Bundled widget component imports ----------------------------------------

import { MusicLibraryCharacterWidget } from "../components/character/MusicLibraryCharacterWidget";
import { AgentActivityWidget } from "../components/chat/widgets/agent-activity";
import { AGENT_ORCHESTRATOR_PLUGIN_WIDGETS } from "../components/chat/widgets/agent-orchestrator";
import { AGENT_PROVISIONING_HOME_WIDGET } from "../components/chat/widgets/agent-provisioning";
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
import { WorkflowsWidget } from "../components/chat/widgets/workflows";

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
// always resolves (see ALWAYS_VISIBLE_BUILTIN_WIDGET_PLUGIN_IDS). (#9143)
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
// Running workflows tile (ITEM 5): backed by the core GET /api/automations
// surface (system automations + active user workflows), so it is always-visible
// and self-hides when nothing is running.
registerWidgetComponent("workflow", "workflow.running", WorkflowsWidget);
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

const APP_HOME_DEFAULT_WIDGET_DECLARATIONS: PluginWidgetDeclaration[] = (
  [
    {
      pluginId: "blocker",
      label: "Focus",
      icon: "Shield",
      defaultWidget: "notifications",
      signalKinds: ["blocked", "reminder", "notification"],
    },
    {
      pluginId: "contacts",
      label: "Contacts",
      icon: "Contact",
      defaultWidget: "activity",
      signalKinds: ["nudge", "activity"],
    },
    {
      pluginId: "device-settings",
      label: "Device Settings",
      icon: "Settings",
      defaultWidget: "notifications",
      signalKinds: ["notification", "activity"],
    },
    {
      pluginId: "documents",
      label: "Documents",
      icon: "FileText",
      defaultWidget: "activity",
      signalKinds: ["approval", "workflow", "activity"],
    },
    // The `feed` plugin owns the real `feed.agent-activity` home tile (declared
    // below), so it no longer opts into the shared messages sink here.
    {
      pluginId: "form",
      label: "Forms",
      icon: "ClipboardList",
      defaultWidget: "activity",
      signalKinds: ["approval", "workflow", "activity"],
    },
    {
      pluginId: "hyperliquid",
      label: "Hyperliquid",
      icon: "ChartCandlestick",
      defaultWidget: "notifications",
      signalKinds: ["escalation", "notification", "activity"],
    },
    {
      pluginId: "model-tester",
      label: "Model Tester",
      icon: "Gauge",
      defaultWidget: "activity",
      signalKinds: ["workflow", "activity"],
    },
    {
      pluginId: "native-settings",
      label: "Native Settings",
      icon: "Settings",
      defaultWidget: "notifications",
      signalKinds: ["notification", "activity"],
    },
    {
      pluginId: "personal-assistant",
      label: "Personal Assistant",
      icon: "Sparkles",
      defaultWidget: "notifications",
      signalKinds: ["reminder", "check-in", "notification"],
    },
    {
      // The @elizaos/plugin-messages app plugin no longer ships its own home
      // tile — the standalone Messages widget was removed as redundant with the
      // always-present chat overlay (#10697). Follow-up-worthy messages surface
      // as `category: "message"` notifications, so it folds into that rail.
      pluginId: "messages",
      label: "Messages",
      icon: "MessageSquare",
      defaultWidget: "notifications",
      signalKinds: ["message", "notification"],
    },
    {
      pluginId: "phone",
      label: "Phone",
      icon: "Phone",
      // Follow-up messages fold into the notification rail (#10697); the
      // standalone Messages tile was removed as redundant with the chat overlay.
      defaultWidget: "notifications",
      signalKinds: ["message", "notification"],
    },
    {
      pluginId: "polymarket",
      label: "Polymarket",
      icon: "ChartNoAxesCombined",
      defaultWidget: "notifications",
      signalKinds: ["escalation", "notification", "activity"],
    },
    {
      pluginId: "screenshare",
      label: "Screen Share",
      icon: "MonitorUp",
      defaultWidget: "activity",
      signalKinds: ["workflow", "activity"],
    },
    {
      pluginId: "shopify",
      label: "Shopify",
      icon: "ShoppingBag",
      defaultWidget: "notifications",
      signalKinds: ["approval", "notification", "activity"],
    },
    {
      pluginId: "task-coordinator",
      label: "Task Coordinator",
      icon: "ListChecks",
      defaultWidget: "activity",
      signalKinds: ["blocked", "workflow", "activity"],
    },
    {
      pluginId: "todos",
      label: "Todos",
      icon: "ListTodo",
      defaultWidget: "activity",
      signalKinds: ["reminder", "check-in", "nudge"],
    },
    {
      pluginId: "training",
      label: "Fine Tuning",
      icon: "Brain",
      defaultWidget: "activity",
      signalKinds: ["workflow", "activity"],
    },
    {
      pluginId: "trajectory-logger",
      label: "Trajectory Logger",
      icon: "Route",
      defaultWidget: "activity",
      signalKinds: ["workflow", "activity"],
    },
    {
      pluginId: "vector-browser",
      label: "Vector Browser",
      icon: "Search",
      defaultWidget: "activity",
      signalKinds: ["workflow", "activity"],
    },
    {
      pluginId: "wallet-ui",
      label: "Wallet",
      icon: "Wallet",
      defaultWidget: "notifications",
      signalKinds: ["approval", "escalation", "notification"],
    },
    {
      pluginId: "wifi",
      label: "WiFi",
      icon: "Wifi",
      defaultWidget: "notifications",
      signalKinds: ["notification", "activity"],
    },
  ] as const
).map((declaration, index) => ({
  id: `${declaration.pluginId}.default-home`,
  slot: "home" as const,
  order: 300 + index,
  defaultEnabled: true,
  ...declaration,
}));

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
      BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS.add(id);
    }
  }
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
  // loadable plugin, so it is always-visible (see
  // ALWAYS_VISIBLE_BUILTIN_WIDGET_PLUGIN_IDS) and self-hides when nothing is
  // pending. Floats up at approval/escalation weight on its own data.
  {
    id: NEEDS_ATTENTION_HOME_WIDGET.id,
    pluginId: NEEDS_ATTENTION_HOME_WIDGET.pluginId,
    slot: "home",
    label: "Needs response",
    icon: "CircleHelp",
    order: NEEDS_ATTENTION_HOME_WIDGET.order,
    defaultEnabled: true,
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
    signalKinds: CALENDAR_HOME_WIDGET.signalKinds,
    size: { cols: 2, rows: 1 },
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
    signalKinds: MODEL_DOWNLOAD_HOME_WIDGET.signalKinds,
    size: { cols: 2, rows: 1 },
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
  },
  {
    id: MUSIC_PLAYER_WIDGET.id,
    pluginId: MUSIC_PLAYER_WIDGET.pluginId,
    slot: "chat-sidebar",
    label: "Music",
    icon: "Music",
    order: MUSIC_PLAYER_WIDGET.order,
    defaultEnabled: MUSIC_PLAYER_WIDGET.defaultEnabled,
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
 * Some bundled widgets intentionally stay visible even when the runtime plugin
 * snapshot omits their feature IDs because the UI has compat-backed data
 * sources for them. Generic task-list widgets do not qualify here — Eliza does
 * not ship a runtime task-list plugin, and leaving the fallback enabled would
 * crowd the sidebar with a stale generic tasks panel.
 */
const BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS = new Set([
  "agent-orchestrator",
  // Wallet + browser-workspace are core app-core surfaces, not separately
  // loadable plugins, so their widgets must render even when the runtime
  // plugin snapshot doesn't list them as plugins.
  "wallet",
  "browser-workspace",
  // Todos render from the workbench store; show on the frontpage even before the
  // runtime plugin snapshot lists the plugin (#9143).
  "todo",
]);

const ALWAYS_VISIBLE_BUILTIN_WIDGET_PLUGIN_IDS = new Set([
  "music-player",
  // First-time-user welcome (#9959): a core FTU surface, not a loadable plugin —
  // must render on a fresh account before any plugin snapshot arrives, and
  // self-retires via the sunset lifecycle.
  "welcome",
  // Notifications is a core runtime feature (NotificationService), not a
  // loadable plugin, so its frontpage widget must render regardless of the
  // plugin snapshot. (#9143). Messages was removed (#9304) — redundant with the
  // always-present chat overlay.
  "notifications",
  // Needs-response is backed by the core ApprovalService (not a loadable
  // plugin), so its frontpage widget must render regardless of the plugin
  // snapshot — it self-hides when no decisions are pending (#9449).
  "needs-attention",
  // Curated home-grid widgets backed by core API surfaces, not loadable
  // plugins. They must render regardless of the plugin snapshot so the home
  // grid is populated on first paint; each shows populated data, a
  // connected-but-empty state, or self-hides when empty.
  "feed",
  "wallet",
  "calendar",
  "relationships",
  // Running-workflows tile backed by GET /api/automations (system automations +
  // active user workflows); always-visible since it self-hides when nothing is
  // running. `workflow` matches @elizaos/plugin-workflow (default-enabled).
  "workflow",
  // Setup-progress tiles backed by core surfaces, not loadable plugins: the
  // local model download (local-inference hub) and the cloud-agent provisioning
  // handoff (cloud handoff phase). Must render regardless of the plugin snapshot
  // so a fresh local/cloud agent watches setup on the home grid; each self-hides
  // when there's nothing in flight (model ready / dedicated agent attached).
  "local-inference",
  "cloud-agent",
]);

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
  // Some always-visible ids (calendar / relationships / workflow) ARE backed by
  // real loadable plugins, so an explicit "present + disabled" snapshot entry
  // must still hide them — the always-visible short-circuit is for core surfaces
  // with NO plugin package (welcome/notifications/needs-attention/feed/wallet/
  // …), which never appear in the snapshot and so pass this check untouched.
  const snapshotPlugin = plugins.find((p) => p.id === declaration.pluginId);
  if (
    snapshotPlugin &&
    snapshotPlugin.enabled === false &&
    snapshotPlugin.isActive !== true
  ) {
    return false;
  }

  if (
    source === "builtin" &&
    declaration.defaultEnabled !== false &&
    ALWAYS_VISIBLE_BUILTIN_WIDGET_PLUGIN_IDS.has(declaration.pluginId)
  ) {
    return true;
  }

  if (plugins.length === 0) {
    return (
      declaration.defaultEnabled !== false &&
      (source !== "builtin" ||
        BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS.has(declaration.pluginId))
    );
  }

  const plugin = plugins.find((p) => p.id === declaration.pluginId);
  if (!plugin) {
    return (
      source === "builtin" &&
      declaration.defaultEnabled !== false &&
      BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS.has(declaration.pluginId)
    );
  }

  return plugin.isActive === true || plugin.enabled !== false;
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
