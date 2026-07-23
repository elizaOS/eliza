/** Public runtime and domain exports for managed Cloud Notes and Calendar. */

export { simpleViewsPlugin, simpleViewsPlugin as default } from "./plugin.js";
export {
  SIMPLE_VIEWS_SERVICE_TYPE,
  SIMPLE_VIEWS_STATE_UPDATED_EVENT,
  SimpleViewsService,
} from "./service.js";
export type {
  SimpleCalendarEvent,
  SimpleViewsSnapshot,
  StickyColor,
  StickyNote,
} from "./types.js";
