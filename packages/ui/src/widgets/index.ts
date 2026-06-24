export {
  ACTIVITY_EVENT_SINK,
  ACTIVITY_SIGNAL_SINKS,
  activityEventSink,
  activityEventsToHomeSignals,
} from "./activity-signals";
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
export type { WidgetPluginState } from "./registry";

export {
  BUILTIN_WIDGET_DECLARATIONS,
  getWidgetComponent,
  registerBuiltinWidgetDeclarations,
  registerBuiltinWidgets,
  registerWidgetComponent,
  resolveWidgetsForSlot,
} from "./registry";
export type {
  PluginWidgetDeclaration,
  WidgetProps,
  WidgetRegistration,
  WidgetSlot,
} from "./types";
export type { WidgetHostProps, WidgetUiActionEventDetail } from "./WidgetHost";
export { WidgetHost } from "./WidgetHost";
export { WIDGET_UI_ACTION_EVENT } from "./WidgetHost.constants";
