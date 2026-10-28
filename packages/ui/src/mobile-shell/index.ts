/**
 * Mobile resident shell: product registration and theme, canonical view ids
 * and registry, navigation, the launcher join, Home, All apps and lazy view
 * hosting. This entry imports only these leaves, never the package barrel;
 * `@elizaos/ui/mobile-shell/core` is the same model without React components.
 */
export * from "./core";
export {
  MobileAllAppsDrawer,
  type MobileAllAppsDrawerProps,
} from "./MobileAllAppsDrawer";
export {
  MobileHomeScreen,
  type MobileHomeScreenProps,
  type MobileHomeTile,
  type MobileShellPartProps,
} from "./MobileHomeScreen";
export { type MobileViewError, MobileViewHost } from "./MobileViewHost";
export {
  createMobileShellLauncher,
  type MobileHomeEntry,
  type MobileShellLauncher,
} from "./mobile-launcher";
