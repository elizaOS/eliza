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

export { browserAutofillLoginAction } from "./actions/browser-autofill-login.js";
export { browserSessionAction } from "./actions/browser-session.js";
export {
  BROWSER_BRIDGE_SUBACTIONS,
  type BrowserBridgeSubaction,
  manageBrowserBridgeAction,
} from "./actions/manage-browser-bridge.js";
export * from "./contracts.js";
export * from "./packaging.js";
export { browserPlugin } from "./plugin.js";
export * from "./routes.js";
export * from "./schema.js";
export * from "./service.js";
export * from "./workspace/browser-workspace.js";
