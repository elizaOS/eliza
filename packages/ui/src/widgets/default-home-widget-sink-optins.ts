/**
 * Legacy host-owned fallback: default-home widget sink opt-ins (#12089 item 35).
 *
 * App-manifest plugins that do NOT ship an owned home card (no bundled widget
 * component, no `Plugin.widgets` declaration) historically opted into one of the
 * shared default sinks (`activity` / `notifications`) via a ~23-entry literal
 * array hardcoded in the UI trunk (`registry.ts`). That array was a second,
 * hand-maintained widget registry: it duplicated each plugin's `pluginId` and
 * had to be edited in the UI package every time an app plugin wanted to
 * participate in the frontpage widget system — exactly the "central name list a
 * plugin cannot own" coupling the arch-audit flags.
 *
 * The canonical, owner-declared path is a plugin shipping its own
 * `widgets: PluginWidgetDeclaration[]` on its `Plugin` instance; the server
 * merges those (see `@elizaos/agent` `getPluginWidgets`) and they arrive as
 * snapshot-gated `server` declarations that take precedence. This table is the
 * explicitly-marked, tested **legacy host-owned fallback** for the app plugins
 * that have not yet migrated their opt-in onto their own manifest — kept as pure
 * data (no assembly logic) so it is a declaration list, not an if-chain, and so
 * a plugin migrating to `Plugin.widgets` simply drops its row here with no other
 * UI-trunk edit. A plugin that DOES declare its own widget wins over its legacy
 * row (proven by the drift guard test) so the two cannot silently diverge.
 *
 * To retire a row: ship the equivalent `PluginWidgetDeclaration` on the plugin's
 * own `Plugin.widgets` and delete the entry below.
 */
import type { PluginWidgetDeclaration } from "./types";

type DefaultHomeWidgetSink = NonNullable<
  PluginWidgetDeclaration["defaultWidget"]
>;

/**
 * A single plugin's opt-in into a shared default home sink. Only the
 * plugin-owned metadata (identity, label, icon, which shared sink, and the
 * signal kinds that boost it) lives here; the structural fields (`id`, `slot`,
 * `order`, `defaultEnabled`) are derived uniformly by
 * `buildDefaultHomeWidgetDeclarations` so no row can drift on shape.
 */
export interface DefaultHomeWidgetSinkOptIn {
  /** Owning plugin id (app-manifest plugin id). */
  pluginId: string;
  /** Display label for the default-home tile. */
  label: string;
  /** Lucide icon name. */
  icon: string;
  /** Which shared default sink this plugin's signals fold into. */
  defaultWidget: DefaultHomeWidgetSink;
  /** Signal kinds that boost this plugin's presence on the home grid. */
  signalKinds: PluginWidgetDeclaration["signalKinds"];
}

/**
 * LEGACY host-owned fallback opt-ins. Each row is owned by the named plugin and
 * should migrate to that plugin's `Plugin.widgets` declaration; until it does,
 * this fallback keeps the plugin participating in the frontpage widget system.
 * Ordered only for a stable, deterministic `order` assignment — membership, not
 * position, is the contract.
 */
export const LEGACY_DEFAULT_HOME_WIDGET_SINK_OPTINS: readonly DefaultHomeWidgetSinkOptIn[] =
  [
    {
      pluginId: "birdclaw",
      label: "Birdclaw",
      icon: "Bird",
      defaultWidget: "activity",
      signalKinds: ["activity", "notification"],
    },
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
    // in registry.ts), so it no longer opts into the shared messages sink here.
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
      // Follow-up messages fold into the notification rail (#10697); the
      // standalone Messages tile was removed as redundant with the chat overlay.
      icon: "Phone",
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
  ];

/**
 * First `order` slot for the default-home sink opt-ins. Kept above the
 * per-plugin real-data widgets so a bespoke card always outranks a plugin's
 * generic default-sink tile.
 */
export const DEFAULT_HOME_WIDGET_OPTIN_ORDER_BASE = 300;

/**
 * Assemble the full `home`-slot `PluginWidgetDeclaration`s for the legacy
 * default-sink opt-ins. Pure derivation from
 * {@link LEGACY_DEFAULT_HOME_WIDGET_SINK_OPTINS}: every structural field is
 * uniform, so a row cannot drift on `id`/`slot`/`order`/`defaultEnabled` shape.
 * Accepts the table as a parameter (defaulted) so tests can exercise the builder
 * in isolation.
 */
export function buildDefaultHomeWidgetDeclarations(
  optIns: readonly DefaultHomeWidgetSinkOptIn[] = LEGACY_DEFAULT_HOME_WIDGET_SINK_OPTINS,
): PluginWidgetDeclaration[] {
  return optIns.map((optIn, index) => ({
    id: `${optIn.pluginId}.default-home`,
    slot: "home" as const,
    order: DEFAULT_HOME_WIDGET_OPTIN_ORDER_BASE + index,
    defaultEnabled: true,
    pluginId: optIn.pluginId,
    label: optIn.label,
    icon: optIn.icon,
    defaultWidget: optIn.defaultWidget,
    signalKinds: optIn.signalKinds,
  }));
}
