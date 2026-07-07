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
  markWidgetRegistryChanged,
  registerBuiltinWidgets,
  registerWidgetComponent,
} from "./registry-store";
import type { PluginWidgetDeclaration, WidgetProps, WidgetSlot } from "./types";

export {
  getWidgetComponent,
  getWidgetRegistryVersion,
  registerBuiltinWidgets,
  registerWidgetComponent,
  subscribeWidgetRegistry,
} from "./registry-store";

// -- Bundled widget component imports ----------------------------------------

import { MusicLibraryCharacterWidget } from "../components/character/MusicLibraryCharacterWidget";
import { AGENT_ORCHESTRATOR_PLUGIN_WIDGETS } from "../components/chat/widgets/agent-orchestrator";
import { BROWSER_STATUS_WIDGET } from "../components/chat/widgets/browser-status.helpers";
import { CALENDAR_HOME_WIDGET } from "../components/chat/widgets/calendar-upcoming";
import { MODEL_DOWNLOAD_HOME_WIDGET } from "../components/chat/widgets/model-download";
import { MUSIC_PLAYER_WIDGET } from "../components/chat/widgets/music-player.helpers";
import { NEEDS_ATTENTION_HOME_WIDGET } from "../components/chat/widgets/needs-attention";
import { TODO_PLUGIN_WIDGETS } from "../components/chat/widgets/todo";

// The wallet / goals / sleep resident components are no longer registered
// here: their home declarations were removed (spec §E items 3-5). The components
// stay in the tree for routed surfaces, tests, and stories, not for the home
// widget registry.

// -- Seed bundled widgets into the registry ----------------------------------

registerBuiltinWidgets(AGENT_ORCHESTRATOR_PLUGIN_WIDGETS);
registerBuiltinWidgets([BROWSER_STATUS_WIDGET, MUSIC_PLAYER_WIDGET]);
// Register the todo widget's component so it can be declared on the curated
// home slot. Idempotent with the plugin's own runtime registration.
registerBuiltinWidgets(TODO_PLUGIN_WIDGETS);
registerWidgetComponent(
  "music-library",
  "music-library.playlists",
  MusicLibraryCharacterWidget,
);
// Curated home-grid widgets backed by core API surfaces. Each renders populated
// data, a connected-but-empty state, or self-hides - always-visible so the home
// grid can surface essential state before the runtime plugin snapshot arrives.
// Activity, running workflow, inbox, finances, relationships, wallet, and
// orchestrator cards are intentionally kept off home; those domains remain
// available through launcher/routed views.
// Setup-progress home tiles: the local model download (LOCAL mode, backed by the
// local-inference hub) and the cloud-agent provisioning handoff (CLOUD mode,
// backed by the cloud handoff phase event). Neither is a loadable plugin, so
// both are always-visible and self-hide when there's nothing in flight - the
// recommended model finishes downloading, or the dedicated cloud agent attaches.
registerWidgetComponent(
  MODEL_DOWNLOAD_HOME_WIDGET.pluginId,
  MODEL_DOWNLOAD_HOME_WIDGET.id,
  MODEL_DOWNLOAD_HOME_WIDGET.Component,
);
// Per-plugin frontpage widgets: each surfaces a compact, attention-ranked slice
// of its plugin's own state on the home grid, self-hides when empty, and
// self-publishes a home-attention signal so it floats up on its own data
// urgency. They resolve only when the plugin is enabled+active in the runtime
// snapshot. Goals + health left this set (spec §E items 4-5): the at-risk goal
// is absorbed into the Today (todo) card and sleep moved to its routed dashboard,
// so neither registers a home component here anymore.
for (const w of [CALENDAR_HOME_WIDGET, NEEDS_ATTENTION_HOME_WIDGET]) {
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
  // The first-time-user welcome card (greeting + "try saying…" suggestion
  // chips) and tutorial-launch card were removed deliberately: the agent is
  // proactive on a cold home, with onboarding help living in first-run and chat
  // commands rather than resident dashboard prompts. A quiet MVP home must stay
  // empty of canned tutorial/help cards.
  // Notifications are deliberately NOT a ranked home-slot widget: the dashboard
  // notification center (NotificationsHomeCenter) is pinned by HomeScreen
  // directly below the time/weather base, so a registry entry here would
  // double-render the inbox.
  // The standalone Recent-conversations tile was removed (#10697) - it
  // duplicated the always-present chat overlay. Follow-up-worthy messages now
  // surface as `category: "message"` notifications in the notification rail.
  // Agent Orchestrator - app runs
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
  // Agent Orchestrator - activity
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
  // Todos - the todo plugin's curated LifeOps frontpage widget.
  {
    id: "todo.items",
    pluginId: "todo",
    slot: "home",
    label: "Todos",
    icon: "ListTodo",
    order: 80,
    defaultEnabled: true,
    // Renders from the workbench store, so it shows even before the runtime
    // plugin snapshot lists the plugin. Declaration-driven `fallback`
    // replaces the hardcoded `"todo"` allow-set entry that used to drift out of
    // sync with the `todos` app-manifest plugin id (#12090 item 9).
    visibility: "fallback",
    signalKinds: ["reminder", "check-in", "nudge"],
  },
  // -- Sparse home widgets ---------------------------------------------------
  // Home keeps only essential, low-noise cards. Rich domain surfaces like inbox,
  // finances, relationships, workflow activity, feed activity, and orchestrator
  // app runs remain available through launcher/routed views, not resident cards.
  // Needs response - the canonical "actions requiring your response" card
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
  // Setup progress and wallet remain on home. Other app/domain views are
  // launcher destinations so an idle home does not poll those feature APIs.
  // Local model download (LOCAL mode): surfaces the recommended on-device text
  // model downloading - queued / %-progress / loading / failed-with-retry - so a
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
    // plugin - always-visible, self-hides once the model is ready.
    visibility: "always",
    signalKinds: MODEL_DOWNLOAD_HOME_WIDGET.signalKinds,
    // Full-width, double-height: model download/activation is the one thing
    // standing between a fresh local agent and its first reply, so it owns a
    // whole row with a real progress bar (it self-hides once ready).
    size: { cols: 4, rows: 2 },
  },
  // The cloud-agent provisioning tile is NO LONGER a home resident (owner
  // call, 2026-07-07): for shared-tier users it rendered a permanent
  // "Setting up…" card against a healthy running agent. Provisioning state
  // still surfaces via CloudHandoffBanner and the chat provisioning tile;
  // the widget component stays in the tree for those surfaces and stories.
  // The wallet, sleep, and standalone goals residents are NO LONGER home
  // residents (spec §B "Explicitly NOT residents" / §E items 3-5):
  //  - wallet: a balance is state, not change. It fails the two-second "what
  //    changed while I was gone?" rule. The wallet component + routed view stay;
  //    a material balance delta becomes a producer-side notification instead.
  //    (See the wallet producer follow-up note in PR #14560; the
  //    balance-change hook lives store-side, not here.)
  //  - sleep: yesterday's sleep score is a daily-digest fact, not resting
  //    urgency; the threshold-crossed alert already travels as a `health`
  //    notification category. The sleep component + routed dashboard stay; only
  //    the home declaration is removed.
  //  - goals: merged into the Today (todo.items) card. An at-risk goal renders
  //    as one flagged row inside Today and the card self-publishes the goals
  //    escalation weight. The goals component stays for routed use.
  // Browser workspace status - surfaces /browser state in the right rail.
  {
    id: BROWSER_STATUS_WIDGET.id,
    pluginId: BROWSER_STATUS_WIDGET.pluginId,
    slot: "chat-sidebar",
    label: "Browser",
    icon: "Globe",
    order: BROWSER_STATUS_WIDGET.order,
    defaultEnabled: BROWSER_STATUS_WIDGET.defaultEnabled,
    // Core app-core surface (browser-workspace), not a loadable plugin - shows
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
    // Core playback surface, not a loadable plugin - always-visible.
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
 * declarations no longer rely on a hardcoded id set - each carries its own
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
}

type WidgetDeclarationSource = "builtin" | "server";

function isWidgetEnabled(
  declaration: PluginWidgetDeclaration,
  plugins: readonly WidgetPluginState[],
  source: WidgetDeclarationSource,
): boolean {
  if (declaration.defaultEnabled === false) return false;

  const visibility = widgetVisibilityClass(declaration, source);

  // Some always-visible ids (calendar / health) ARE backed by
  // real loadable plugins, so an explicit "present + disabled" snapshot entry
  // must still hide them - the always/fallback short-circuits are for core
  // surfaces with NO plugin package (welcome/notifications/needs-attention/
  // wallet/…), which never appear in the snapshot and so pass this check
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
  // before the snapshot entry - a race we don't want to hide it), but a
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
 * (from PluginInfo.widgets), deduplicating by declaration ID. A declaration
 * resolves only when it has a registered React component or a `uiSpec`;
 * everything else is dropped, so a declaration this build cannot render never
 * reaches the host.
 */
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

    const Component = getWidgetComponent(declaration.pluginId, declaration.id);

    // Include if we have a React component OR a uiSpec fallback.
    if (Component || declaration.uiSpec) {
      results.push({ declaration, Component: Component ?? null });
    }
  }

  results.sort(
    (a, b) => (a.declaration.order ?? 100) - (b.declaration.order ?? 100),
  );

  return results;
}
