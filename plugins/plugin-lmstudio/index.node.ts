/**
 * Node/Bun build entry — re-exports the LM Studio plugin surface for the server bundle.
 */

import { lmStudioPlugin } from "./plugin";

export * from "./types";
export * from "./utils/config";
export * from "./utils/detect";
export { lmStudioPlugin };

const defaultLMStudioPlugin = lmStudioPlugin;

export default defaultLMStudioPlugin;
