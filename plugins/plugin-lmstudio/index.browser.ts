/**
 * Browser build entry — re-exports the LM Studio plugin surface for the browser
 * bundle. Only usable when LM Studio sits behind a CORS-permissive proxy.
 */

import { lmStudioPlugin } from "./plugin";

export * from "./types";
export * from "./utils/config";
export * from "./utils/detect";
export { lmStudioPlugin };

const defaultLMStudioPlugin = lmStudioPlugin;

export default defaultLMStudioPlugin;
