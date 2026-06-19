/**
 * Barrel exports for plugin-computeruse services.
 */

export { ComputerUseService } from "./computer-use-service.js";
export type {
  DesktopControlCapabilities,
  DesktopControlCapability,
  DesktopInputButton,
  DesktopScreenshotRegion,
  DesktopWindowInfo,
} from "./desktop-control.js";
export {
  VISION_CONTEXT_SERVICE_TYPE,
  VISION_CONTEXT_TASK_GOAL_CACHE_KEY,
  type VisionContext,
  type VisionContextBBox,
  type VisionContextFocusedWindow,
  VisionContextProvider,
  type VisionContextRecentAction,
} from "./vision-context-provider.js";
