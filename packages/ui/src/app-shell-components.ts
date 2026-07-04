/**
 * Slot registry for host-injected shell components — the types and setters the
 * host uses to contribute shell chrome the App renders.
 */
export type {
  AppShellPageLoader,
  AppShellPageRegistration,
} from "./app-shell-registry";
export {
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  registerAppShellPage,
  subscribeAppShellPages,
} from "./app-shell-registry";
