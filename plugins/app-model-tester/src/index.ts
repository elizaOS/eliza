/** Package entry: re-exports the plugin, overlay app, routes, and views, and imports the app module for its registration side effects. */
export * from "./ModelTesterAppView.js";
export { ModelTesterView } from "./ModelTesterView.js";
export { MODEL_TESTER_APP_NAME, modelTesterApp } from "./model-tester-app.js";
export { modelTesterPlugin } from "./plugin.js";
export * from "./routes.js";

import "./model-tester-app";
