export type {
  BackgroundEditAction,
  BackgroundEditPayload,
} from "./BACKGROUND_EDIT-action-contract";
export {
  applyBackgroundEdit,
  BACKGROUND_EDIT_ACTION_TYPE,
} from "./BACKGROUND_EDIT-action-contract";
export type { BackgroundHostProps } from "./BackgroundHost";
export { BackgroundHost } from "./BackgroundHost";
export {
  getActiveBackground,
  getBackground,
  getBackgroundHistory,
  listBackgrounds,
  registerBackground,
  resetBackgroundRegistry,
  revertBackground,
  setActiveBackground,
} from "./registry";
export { createSlowCloudsBackground } from "./slow-clouds";
export type {
  BackgroundHandle,
  BackgroundKind,
  BackgroundModule,
  BackgroundState,
} from "./types";
export { SKY_BACKGROUND_COLOR, SKY_BACKGROUND_CSS } from "./types";
