/**
 * The mobile shell without its React components: product registration and
 * theme, canonical view ids and routes, the view registry, the navigation
 * reducer (views, Back, the drawer and the assistant detent), the gesture
 * zones and the one launcher favorites migration. Runtime and background code (agent
 * navigation, voice, capture) import this entry so they never load Home,
 * All apps or a domain view.
 */
export {
  MOBILE_SHELL_CANVAS_WIDTH,
  MOBILE_SHELL_EDGE,
  MOBILE_SHELL_HOME_BAR_TOP,
  MOBILE_SHELL_SWIPE_THRESHOLD,
  type MobileShellSwipeAction,
  type MobileShellSwipeOptions,
  type MobileShellSwipeStart,
  type MobileShellSwipeState,
  resolveMobileShellSwipe,
} from "./gestures";
export {
  MOBILE_SHELL_HOME,
  MOBILE_SHELL_STACK_LIMIT,
  type MobileAssistantDetent,
  type MobileAssistantRest,
  type MobileShellNavigation,
  type MobileShellNavigationAction,
  type MobileShellNavigationOptions,
  mobileAssistantRest,
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
  type MobileShellPaletteColor,
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
  type MobileViewContribution,
  type MobileViewLoader,
  type MobileViewProps,
  type MobileViewRegistration,
  type MobileViewRegistry,
  type MobileViewTarget,
} from "./view-registry";
