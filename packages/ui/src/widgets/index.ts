export type { WidgetPluginState } from "./registry";

export {
  BUILTIN_WIDGET_DECLARATIONS,
  getWidgetComponent,
  registerBuiltinWidgetDeclarations,
  registerBuiltinWidgets,
  registerWidgetComponent,
  resolveWidgetsForSlot,
} from "./registry";
export { seedLegacyWidgets } from "./registry-store";
export type {
  PluginWidgetDeclaration,
  WidgetProps,
  WidgetRegistration,
  WidgetSlot,
} from "./types";
export type { WidgetHostProps, WidgetUiActionEventDetail } from "./WidgetHost";
export { WIDGET_UI_ACTION_EVENT, WidgetHost } from "./WidgetHost";
