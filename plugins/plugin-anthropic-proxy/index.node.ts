/** Node platform entry: re-exports the full plugin (service, action, route, transforms) from `index.ts`. */

import pluginDefault from "./index";

export * from "./index";
export default pluginDefault;
