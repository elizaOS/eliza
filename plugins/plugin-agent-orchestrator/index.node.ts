/**
 * Node build entry: re-exports the plugin surface with an explicit default binding for Node bundlers.
 */
export * from "./src/index.js";

import _defaultExport from "./src/index.js";
export default _defaultExport;
