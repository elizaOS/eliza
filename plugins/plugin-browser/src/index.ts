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
export { browserPlugin } from "./plugin.js";
export * from "./routes.js";
export * from "./schema.js";
export * from "./service.js";
