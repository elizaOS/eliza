/**
 * Chat-sidebar widgets for the `agent-orchestrator` plugin (Apps / Tasks /
 * Activity). This file lives in `@elizaos/app-core` (not in
 * `@elizaos/plugin-agent-orchestrator`) because the widget depends on app-core
 * internals that the runtime plugin does not own and does not re-export:
 * the app-core API client, `AppRunSummary` / `ActivityEvent` types, the
 * `useApp` store, `TranslateFn`, `getRunAttentionReasons`, and the widget
 * registry contract (`ChatSidebarWidgetDefinition` / `ChatSidebarWidgetProps`
 * and the `EmptyWidgetState` / `WidgetSection` primitives).
 *
 * The runtime plugin is a pure Node package (actions, providers, services,
 * api, types) with no React build target or widget-publication mechanism.
 * Moving this file into the plugin would require standing up a React build,
 * publishing app-core internals, and adding a widget-registration hook — a
 * reverse coupling we don't want. The widget is owned by the app shell; the
 * plugin just provides the backend capabilities it consumes.
 */
import type { ChatSidebarWidgetDefinition } from "./types";
export declare const AGENT_ORCHESTRATOR_PLUGIN_WIDGETS: ChatSidebarWidgetDefinition[];
//# sourceMappingURL=agent-orchestrator.d.ts.map
