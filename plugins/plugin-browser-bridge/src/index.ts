/**
 * Agent Browser Bridge — public barrel.
 *
 * Import specific surfaces through the subpath exports defined in
 * `package.json`:
 *   - `@elizaos/plugin-browser-bridge/contracts`
 *   - `@elizaos/plugin-browser-bridge/schema`
 *   - `@elizaos/plugin-browser-bridge/packaging`
 *   - `@elizaos/plugin-browser-bridge/routes`
 *   - `@elizaos/plugin-browser-bridge/plugin`
 */

export {
  browserBridgeActions,
  browserBridgeInstallAction,
  browserBridgeOpenManagerAction,
  browserBridgeRefreshAction,
  browserBridgeRevealFolderAction,
} from "./actions.js";
export * from "./contracts.js";
export * from "./packaging.js";
export { browserBridgePlugin } from "./plugin.js";
export * from "./routes.js";
export * from "./schema.js";
export * from "./service.js";
