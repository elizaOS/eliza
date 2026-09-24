/** Exposes the canonical UI primitives and first-party login components and hooks. */

export {
  appShellPageMatchesPath,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  registerAppShellPage,
} from "./app-shell-registry.js";
export * from "./components/primitives/index";
export { cn } from "./lib/utils";
export * from "./login/index";
export * from "./login/wallet/index";
