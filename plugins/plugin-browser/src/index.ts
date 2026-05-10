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

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { BROWSER_SERVICE_TYPE as _bs_1_BROWSER_SERVICE_TYPE, BrowserService as _bs_2_BrowserService } from "./browser-service.js";
import { executeBrowserAutofillLogin as _bs_3_executeBrowserAutofillLogin } from "./actions/browser-autofill-login.js";
import { browserAction as _bs_4_browserAction } from "./actions/browser.js";
import { BROWSER_BRIDGE_SUBACTIONS as _bs_5_BROWSER_BRIDGE_SUBACTIONS, manageBrowserBridgeAction as _bs_6_manageBrowserBridgeAction } from "./actions/manage-browser-bridge.js";
import { browserPlugin as _bs_7_browserPlugin } from "./plugin.js";
import { FRAME_FILE as _bs_8_FRAME_FILE, startBrowserCapture as _bs_9_startBrowserCapture, stopBrowserCapture as _bs_10_stopBrowserCapture } from "./workspace/browser-capture.js";
// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_PLUGINS_PLUGIN_BROWSER_SRC_INDEX__ = [_bs_1_BROWSER_SERVICE_TYPE, _bs_2_BrowserService, _bs_3_executeBrowserAutofillLogin, _bs_4_browserAction, _bs_5_BROWSER_BRIDGE_SUBACTIONS, _bs_6_manageBrowserBridgeAction, _bs_7_browserPlugin, _bs_8_FRAME_FILE, _bs_9_startBrowserCapture, _bs_10_stopBrowserCapture];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(globalThis as any).__bundle_safety_PLUGINS_PLUGIN_BROWSER_SRC_INDEX__ = __bundle_safety_PLUGINS_PLUGIN_BROWSER_SRC_INDEX__;
