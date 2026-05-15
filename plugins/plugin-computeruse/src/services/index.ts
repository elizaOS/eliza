/**
 * Barrel exports for plugin-computeruse services.
 */

export { ComputerUseService } from "./computer-use-service.js";
export {
  type DesktopControlCapabilities,
  type DesktopControlCapability,
  type DesktopInputButton,
  type DesktopScreenshotRegion,
  type DesktopWindowInfo,
} from "./desktop-control.js";
export {
  type VisionContext,
  type VisionContextBBox,
  type VisionContextFocusedWindow,
  type VisionContextRecentAction,
  VisionContextProvider,
  VISION_CONTEXT_SERVICE_TYPE,
  VISION_CONTEXT_TASK_GOAL_CACHE_KEY,
} from "./vision-context-provider.js";
