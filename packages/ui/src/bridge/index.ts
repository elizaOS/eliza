/**
 * Barrel for the desktop/native bridges (@elizaos/ui/bridge).
 */

// Shell-privileged raw-global channel (surface-realm guards, #13452): shell
// code outside packages/ui (e.g. the app entrypoint's smoke hooks) reaches it
// through this barrel. `DynamicViewLoader` strips these from the view-facing
// bridge compat, so a view's `@elizaos/ui/bridge` import does not carry them.
export {
  runAsPrivilegedShell,
  SurfaceRealmDeniedError,
  shellHistory,
  shellLocalStorage,
} from "../surface-realm-broker";
export * from "./capacitor-bridge";
export * from "./electrobun-rpc";
export * from "./electrobun-runtime";
export * from "./eliza-window-bridge";
export * from "./native-plugins";
export * from "./plugin-bridge";
export * from "./storage-bridge";
