/**
 * Mobile resident shell: product registration and theme, canonical view ids
 * and registry, navigation, the launcher join, Home, All apps and lazy view
 * hosting. This entry imports only these leaves, never the package barrel.
 */
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
export { MobileViewHost } from "./MobileViewHost";
export {
  createMobileShellLauncher,
  type MobileHomeEntry,
  type MobileShellLauncher,
} from "./mobile-launcher";
export {
  MOBILE_SHELL_HOME,
  MOBILE_SHELL_STACK_LIMIT,
  type MobileShellNavigation,
  type MobileShellNavigationAction,
  navigateMobileShell,
} from "./navigation";
export {
  applyMobileShellTheme,
  defineMobileProductRegistration,
  MOBILE_PRODUCT_SCHEMA,
  MOBILE_PRODUCT_SCHEMA_VERSION,
  MOBILE_SHELL_REQUIRED_COLORS,
  type MobileProductBackgrounds,
  type MobileProductIcons,
  type MobileProductIdentity,
  type MobileProductRegistration,
  type MobileProductStorage,
  type MobileProductTheme,
  type MobileProductViews,
  type MobileShellAppearance,
  type MobileShellChromeColors,
  type MobileShellThemeToken,
  mobileShellIconUrl,
  mobileShellThemeVariables,
  resolveMobileShellAppearance,
  validateMobileProductRegistration,
} from "./product-registration";
export {
  type LauncherViewIdMigration,
  migrateLauncherViewIds,
} from "./view-id-migration";
export {
  isMobileShellViewId,
  MOBILE_SHELL_HOME_VIEW_ID,
  MOBILE_SHELL_VIEW_IDS,
  type MobileShellViewId,
  mobileShellViewPath,
  mobileShellViewPaths,
} from "./view-ids";
export {
  createMobileViewRegistry,
  type MobileViewLoader,
  type MobileViewProps,
  type MobileViewRegistration,
  type MobileViewRegistry,
  type MobileViewTarget,
} from "./view-registry";
