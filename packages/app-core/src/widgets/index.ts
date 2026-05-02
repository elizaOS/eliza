export type { WidgetPluginState } from "./registry";

export {
  BUILTIN_WIDGET_DECLARATIONS,
  getWidgetComponent,
  registerBuiltinWidgetDeclarations,
  registerBuiltinWidgets,
  registerWidgetComponent,
  resolveChatSidebarWidgets,
  resolveWidgetsForSlot,
} from "./registry";
export type {
  PluginWidgetDeclaration,
  WidgetProps,
  WidgetRegistration,
  WidgetSlot,
} from "./types";
export type { WidgetHostProps } from "./WidgetHost";
export { WidgetHost } from "./WidgetHost";
