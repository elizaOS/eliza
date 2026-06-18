import type {
  BrowserBridgePermissionState,
  BrowserBridgeSettings,
} from "@elizaos/plugin-browser";

export const DEFAULT_BROWSER_PERMISSION_STATE: BrowserBridgePermissionState = {
  tabs: false,
  scripting: false,
  activeTab: false,
  allOrigins: false,
  grantedOrigins: [],
  incognitoEnabled: false,
};

export const DEFAULT_BROWSER_SETTINGS: BrowserBridgeSettings = {
  enabled: true,
  trackingMode: "current_tab",
  allowBrowserControl: false,
  requireConfirmationForAccountAffecting: true,
  incognitoEnabled: false,
  siteAccessMode: "current_site_only",
  grantedOrigins: [],
  blockedOrigins: [],
  maxRememberedTabs: 10,
  pauseUntil: null,
  metadata: {},
  updatedAt: null,
};
