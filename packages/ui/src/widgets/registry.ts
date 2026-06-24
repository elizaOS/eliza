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

export {
  getWidgetComponent,
  registerBuiltinWidgets,
  registerWidgetComponent,
} from "./registry-store";

// -- Bundled widget component imports ----------------------------------------

import { MusicLibraryCharacterWidget } from "../components/character/MusicLibraryCharacterWidget";
import { AGENT_ORCHESTRATOR_PLUGIN_WIDGETS } from "../components/chat/widgets/agent-orchestrator";
import { BROWSER_STATUS_WIDGET } from "../components/chat/widgets/browser-status.helpers";
import { CALENDAR_HOME_WIDGET } from "../components/chat/widgets/calendar-upcoming";
import { FINANCES_HOME_WIDGET } from "../components/chat/widgets/finances-alerts";
import { GOALS_HOME_WIDGET } from "../components/chat/widgets/goals-attention";
import { HEALTH_HOME_WIDGET } from "../components/chat/widgets/health-sleep";
import { INBOX_HOME_WIDGET } from "../components/chat/widgets/inbox-unread";
import { MessagesWidget } from "../components/chat/widgets/messages";
import { MUSIC_PLAYER_WIDGET } from "../components/chat/widgets/music-player.helpers";
import { NotificationsWidget } from "../components/chat/widgets/notifications";
import { RELATIONSHIPS_HOME_WIDGET } from "../components/chat/widgets/relationships-attention";
import { TODO_PLUGIN_WIDGETS } from "../components/chat/widgets/todo";

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
// Messages (recent conversations) is likewise a core surface — always-visible.
registerWidgetComponent("messages", "messages.recent", MessagesWidget);

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
]) {
  registerWidgetComponent(w.pluginId, w.id, w.Component);
}

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
  // Messages (recent conversations) — the shared "messages" home widget (#9143).
  {
    id: "messages.recent",
    pluginId: "messages",
    slot: "home",
    label: "Messages",
    icon: "MessageSquare",
    order: 60,
    defaultEnabled: true,
    signalKinds: ["message"],
  },
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
  {
    id: RELATIONSHIPS_HOME_WIDGET.id,
    pluginId: RELATIONSHIPS_HOME_WIDGET.pluginId,
    slot: "home",
    label: "Relationships",
    icon: "Users",
    order: RELATIONSHIPS_HOME_WIDGET.order,
    defaultEnabled: true,
    signalKinds: RELATIONSHIPS_HOME_WIDGET.signalKinds,
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
  // Notifications is a core runtime feature (NotificationService), not a
  // loadable plugin, so its frontpage widget must render regardless of the
  // plugin snapshot. (#9143)
  "notifications",
  // Messages (recent conversations) is likewise a core surface. (#9143)
  "messages",
]);

interface ResolvedWidget {
  declaration: PluginWidgetDeclaration;
  Component: React.ComponentType<WidgetProps> | null;
}

type WidgetDeclarationSource = "builtin" | "server";

function isWidgetEnabled(
  declaration: PluginWidgetDeclaration,
  plugins: readonly WidgetPluginState[],
  source: WidgetDeclarationSource,
): boolean {
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
const DEFAULT_WIDGET_SINK_COMPONENT: Readonly<
  Record<
    NonNullable<PluginWidgetDeclaration["defaultWidget"]>,
    { pluginId: string; id: string }
  >
> = {
  notifications: { pluginId: "notifications", id: "notifications.recent" },
  messages: { pluginId: "messages", id: "messages.recent" },
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
    }

    // Include if we have a React component OR a uiSpec fallback
    if (Component || declaration.uiSpec) {
      results.push({ declaration, Component: Component ?? null });
    }
  }

  results.sort(
    (a, b) => (a.declaration.order ?? 100) - (b.declaration.order ?? 100),
  );

  return results;
}
