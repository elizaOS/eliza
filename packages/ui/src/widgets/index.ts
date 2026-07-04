/**
 * Barrel for the widgets surface: home priority scoring, the registry, and host
 * types.
 */
export {
  baseHomeScore,
  HOME_SIGNAL_WEIGHTS,
  type HomeWidgetSignal,
  homeSignalWeight,
  homeWidgetKey,
  type RankableHomeWidget,
  type RankedHomeWidget,
  type RankHomeWidgetsOptions,
  rankHomeWidgets,
  scoreHomeWidget,
} from "./home-priority";
export type { ResolvedWidget, WidgetPluginState } from "./registry";
export {
  BUILTIN_WIDGET_DECLARATIONS,
  DEFAULT_WIDGET_SINK_COMPONENT,
  getWidgetComponent,
  getWidgetRegistryVersion,
  registerBuiltinWidgetDeclarations,
  registerBuiltinWidgets,
  registerWidgetComponent,
  resolveWidgetsForSlot,
  subscribeWidgetRegistry,
} from "./registry";
export type {
  PluginWidgetDeclaration,
  WidgetProps,
  WidgetRegistration,
  WidgetSlot,
} from "./types";
export type { WidgetVisibilityHook } from "./useChatSidebarVisibility";
export { useWidgetVisibility } from "./useChatSidebarVisibility";
export {
  isWidgetVisible,
  widgetVisibilityKey,
  widgetVisibilityStorageKey,
} from "./visibility";
export type { WidgetHostProps, WidgetUiActionEventDetail } from "./WidgetHost";
export { WidgetHost } from "./WidgetHost";
export { WIDGET_UI_ACTION_EVENT } from "./WidgetHost.constants";
