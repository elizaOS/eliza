/**
 * Package entry — re-exports the LM Studio plugin, its public types, and the
 * config/detect utilities, and exposes the plugin as the default export.
 */

import { lmStudioPlugin } from "./plugin";

export * from "./types";
export * from "./utils/config";
export * from "./utils/detect";
export { lmStudioPlugin };

const defaultLMStudioPlugin = lmStudioPlugin;

export default defaultLMStudioPlugin;
