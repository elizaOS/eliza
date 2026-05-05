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
} from "./actions.ts";
export * from "./contracts.ts";
export * from "./packaging.ts";
export { browserBridgePlugin } from "./plugin.ts";
export * from "./routes.ts";
export * from "./schema.ts";
export * from "./service.ts";
