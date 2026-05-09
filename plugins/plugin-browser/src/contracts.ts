/**
 * Agent Browser Bridge contracts.
 *
 * Transport/domain types for the generic browser companion + packaging
 * surface. LifeOps workflow-bound browser *sessions* (with scoping columns
 * and workflowId) remain in `@elizaos/shared/contracts/lifeops` and
 * continue to reference `BrowserBridgeKind` / `BrowserBridgeAction` from
 * this module.
 */

export const BROWSER_BRIDGE_KINDS = ["chrome", "safari"] as const;
export type BrowserBridgeKind = (typeof BROWSER_BRIDGE_KINDS)[number];

export const BROWSER_BRIDGE_TRACKING_MODES = [
  "off",
  "current_tab",
  "active_tabs",
] as const;
export type BrowserBridgeTrackingMode =
  (typeof BROWSER_BRIDGE_TRACKING_MODES)[number];

export const BROWSER_BRIDGE_SITE_ACCESS_MODES = [
  "current_site_only",
  "granted_sites",
  "all_sites",
] as const;
export type BrowserBridgeSiteAccessMode =
  (typeof BROWSER_BRIDGE_SITE_ACCESS_MODES)[number];

export const BROWSER_BRIDGE_COMPANION_CONNECTION_STATES = [
  "disconnected",
  "connected",
  "paused",
  "permission_blocked",
] as const;
export type BrowserBridgeCompanionConnectionState =
  (typeof BROWSER_BRIDGE_COMPANION_CONNECTION_STATES)[number];

export const BROWSER_BRIDGE_COMPANION_AUTH_ERROR_CODES = [
  "browser_bridge_companion_auth_missing_id",
  "browser_bridge_companion_auth_missing_token",
  "browser_bridge_companion_pairing_invalid",
  "browser_bridge_companion_token_expired",
  "browser_bridge_companion_token_revoked",
] as const;
export type BrowserBridgeCompanionAuthErrorCode =
  (typeof BROWSER_BRIDGE_COMPANION_AUTH_ERROR_CODES)[number];

export const BROWSER_BRIDGE_ACTION_KINDS = [
  "open",
  "navigate",
  "focus_tab",
  "back",
  "forward",
  "reload",
  "click",
  "type",
  "submit",
  "read_page",
  "extract_links",
  "extract_forms",
] as const;
export type BrowserBridgeActionKind =
  (typeof BROWSER_BRIDGE_ACTION_KINDS)[number];

export interface BrowserBridgeAction {
  id: string;
  kind: BrowserBridgeActionKind;
  label: string;
  browser?: BrowserBridgeKind | null;
  windowId?: string | null;
  tabId?: string | null;
  url: string | null;
  selector: string | null;
  text: string | null;
  accountAffecting: boolean;
  requiresConfirmation: boolean;
  metadata: Record<string, unknown>;
}

export interface BrowserBridgePermissionState {
  tabs: boolean;
  scripting: boolean;
  activeTab: boolean;
  allOrigins: boolean;
  grantedOrigins: string[];
  incognitoEnabled: boolean;
}

export interface BrowserBridgeSettings {
  enabled: boolean;
  trackingMode: BrowserBridgeTrackingMode;
  allowBrowserControl: boolean;
  requireConfirmationForAccountAffecting: boolean;
  incognitoEnabled: boolean;
  siteAccessMode: BrowserBridgeSiteAccessMode;
  grantedOrigins: string[];
  blockedOrigins: string[];
  maxRememberedTabs: number;
  pauseUntil: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string | null;
}

export interface UpdateBrowserBridgeSettingsRequest {
  enabled?: boolean;
  trackingMode?: BrowserBridgeTrackingMode;
  allowBrowserControl?: boolean;
  requireConfirmationForAccountAffecting?: boolean;
  incognitoEnabled?: boolean;
  siteAccessMode?: BrowserBridgeSiteAccessMode;
  grantedOrigins?: string[];
  blockedOrigins?: string[];
  maxRememberedTabs?: number;
  pauseUntil?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BrowserBridgeCompanionStatus {
  id: string;
  agentId: string;
  browser: BrowserBridgeKind;
  profileId: string;
  profileLabel: string;
  label: string;
  extensionVersion: string | null;
  connectionState: BrowserBridgeCompanionConnectionState;
  permissions: BrowserBridgePermissionState;
  lastSeenAt: string | null;
  pairedAt: string | null;
  pairingTokenExpiresAt?: string | null;
  pairingTokenRevokedAt?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserBridgeTabSummary {
  id: string;
  agentId: string;
  companionId: string | null;
  browser: BrowserBridgeKind;
  profileId: string;
  windowId: string;
  tabId: string;
  url: string;
  title: string;
  activeInWindow: boolean;
  focusedWindow: boolean;
  focusedActive: boolean;
  incognito: boolean;
  faviconUrl: string | null;
  lastSeenAt: string;
  lastFocusedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserBridgePageContext {
  id: string;
  agentId: string;
  browser: BrowserBridgeKind;
  profileId: string;
  windowId: string;
  tabId: string;
  url: string;
  title: string;
  selectionText: string | null;
  mainText: string | null;
  headings: string[];
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string | null; fields: string[] }>;
  capturedAt: string;
  metadata: Record<string, unknown>;
}

export interface UpsertBrowserBridgeCompanionRequest {
  browser: BrowserBridgeKind;
  profileId: string;
  profileLabel?: string | null;
  label: string;
  extensionVersion?: string | null;
  connectionState?: BrowserBridgeCompanionConnectionState;
  permissions?: Partial<BrowserBridgePermissionState>;
  lastSeenAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SyncBrowserBridgeStateRequest {
  companion: UpsertBrowserBridgeCompanionRequest;
  tabs: Array<{
    browser: BrowserBridgeKind;
    profileId: string;
    windowId: string;
    tabId: string;
    url: string;
    title: string;
    activeInWindow: boolean;
    focusedWindow: boolean;
    focusedActive: boolean;
    incognito?: boolean;
    faviconUrl?: string | null;
    lastSeenAt?: string;
    lastFocusedAt?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  pageContexts?: Array<{
    browser: BrowserBridgeKind;
    profileId: string;
    windowId: string;
    tabId: string;
    url: string;
    title: string;
    selectionText?: string | null;
    mainText?: string | null;
    headings?: string[];
    links?: Array<{ text: string; href: string }>;
    forms?: Array<{ action: string | null; fields: string[] }>;
    capturedAt?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface CreateBrowserBridgeCompanionPairingRequest {
  browser: BrowserBridgeKind;
  profileId: string;
  profileLabel?: string | null;
  label?: string | null;
  extensionVersion?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BrowserBridgeCompanionPairingResponse {
  companion: BrowserBridgeCompanionStatus;
  pairingToken: string;
  pairingTokenExpiresAt: string | null;
}

export interface BrowserBridgeCompanionConfig {
  apiBaseUrl: string;
  companionId: string;
  pairingToken: string;
  pairingTokenExpiresAt?: string | null;
  browser: BrowserBridgeKind;
  profileId: string;
  profileLabel: string;
  label: string;
}

export interface CreateBrowserBridgeCompanionAutoPairRequest {
  browser: BrowserBridgeKind;
  profileId?: string | null;
  profileLabel?: string | null;
  label?: string | null;
  extensionVersion?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BrowserBridgeCompanionAutoPairResponse {
  companion: BrowserBridgeCompanionStatus;
  config: BrowserBridgeCompanionConfig;
}

export interface RevokeBrowserBridgeCompanionRequest {
  reason?: string | null;
}

export interface BrowserBridgeCompanionRevokeResponse {
  companion: BrowserBridgeCompanionStatus;
  revokedAt: string;
}

export interface BrowserBridgeCompanionSyncResponse {
  companion: BrowserBridgeCompanionStatus;
  tabs: BrowserBridgeTabSummary[];
  currentPage: BrowserBridgePageContext | null;
  settings: BrowserBridgeSettings;
  session:
    | import("@elizaos/shared").LifeOpsBrowserSession
    | null;
}

export interface UpdateBrowserBridgeSessionProgressRequest {
  currentActionIndex?: number;
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export const BROWSER_BRIDGE_PACKAGE_PATH_TARGETS = [
  "extension_root",
  "chrome_build",
  "chrome_package",
  "safari_web_extension",
  "safari_app",
  "safari_package",
] as const;
export type BrowserBridgePackagePathTarget =
  (typeof BROWSER_BRIDGE_PACKAGE_PATH_TARGETS)[number];

export interface BrowserBridgeCompanionPackageStatus {
  extensionPath: string | null;
  chromeBuildPath: string | null;
  chromePackagePath: string | null;
  safariWebExtensionPath: string | null;
  safariAppPath: string | null;
  safariPackagePath: string | null;
  releaseManifest: BrowserBridgeCompanionReleaseManifest | null;
}

export interface BrowserBridgeCompanionReleaseAsset {
  fileName: string;
  downloadUrl: string | null;
}

export interface BrowserBridgeCompanionReleaseTarget {
  installKind:
    | "chrome_web_store"
    | "apple_app_store"
    | "github_release"
    | "local_download";
  installUrl: string | null;
  storeListingUrl: string | null;
  asset: BrowserBridgeCompanionReleaseAsset;
}

export interface BrowserBridgeCompanionReleaseManifest {
  schema: "browser_bridge_release_v2";
  releaseTag: string;
  releaseVersion: string;
  repository: string | null;
  releasePageUrl: string | null;
  chromeVersion: string;
  chromeVersionName: string;
  safariMarketingVersion: string;
  safariBuildVersion: string;
  chrome: BrowserBridgeCompanionReleaseTarget;
  safari: BrowserBridgeCompanionReleaseTarget;
  generatedAt: string;
}

export interface OpenBrowserBridgeCompanionPackagePathRequest {
  target: BrowserBridgePackagePathTarget;
  revealOnly?: boolean;
}

export interface OpenBrowserBridgeCompanionPackagePathResponse {
  target: BrowserBridgePackagePathTarget;
  path: string;
  revealOnly: boolean;
}

export interface OpenBrowserBridgeCompanionManagerResponse {
  browser: BrowserBridgeKind;
}
