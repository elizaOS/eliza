/**
 * @elizaos/plugin-browser — public barrel.
 *
 * Import specific surfaces through the subpath exports defined in
 * `package.json`:
 *   - `@elizaos/plugin-browser/contracts`
 *   - `@elizaos/plugin-browser/schema`
 *   - `@elizaos/plugin-browser/packaging`
 *   - `@elizaos/plugin-browser/routes`
 *   - `@elizaos/plugin-browser/plugin`
 *   - `@elizaos/plugin-browser/workspace` (browser-workspace command router)
 */

export {
  BROWSER_SERVICE_TYPE,
  type BrowserTarget,
  BrowserService,
} from "./browser-service.js";
export { executeBrowserAutofillLogin } from "./actions/browser-autofill-login.js";
export { browserAction } from "./actions/browser.js";
export {
  BROWSER_BRIDGE_SUBACTIONS,
  type BrowserBridgeSubaction,
  manageBrowserBridgeAction,
} from "./actions/manage-browser-bridge.js";
export * from "./contracts.js";
export * from "./packaging.js";
export { browserPlugin } from "./plugin.js";
export * from "./routes/bridge.js";
export * from "./schema.js";
export * from "./service.js";
export {
  FRAME_FILE,
  startBrowserCapture,
  stopBrowserCapture,
  type BrowserCaptureConfig,
} from "./workspace/browser-capture.js";
export * from "./workspace/index.js";
export * from "./workspace.js";
