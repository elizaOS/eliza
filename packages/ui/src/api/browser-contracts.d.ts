export type BrowserBridgeKind = "chrome" | "safari";
export type BrowserBridgeTrackingMode = "off" | "current_tab" | "active_tabs";
export type BrowserBridgeSiteAccessMode =
  | "current_site_only"
  | "granted_sites"
  | "all_sites";
export type BrowserBridgeCompanionConnectionState =
  | "disconnected"
  | "connected"
  | "paused"
  | "permission_blocked";
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
  links: Array<{
    text: string;
    href: string;
  }>;
  forms: Array<{
    action: string | null;
    fields: string[];
  }>;
  capturedAt: string;
  metadata: Record<string, unknown>;
}
export interface SyncBrowserBridgeStateRequest {
  companion: {
    browser: BrowserBridgeKind;
    profileId: string;
    profileLabel?: string | null;
    label: string;
    extensionVersion?: string | null;
    connectionState?: BrowserBridgeCompanionConnectionState;
    permissions?: Partial<BrowserBridgePermissionState>;
    lastSeenAt?: string | null;
    metadata?: Record<string, unknown>;
  };
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
    links?: Array<{
      text: string;
      href: string;
    }>;
    forms?: Array<{
      action: string | null;
      fields: string[];
    }>;
    capturedAt?: string;
    metadata?: Record<string, unknown>;
  }>;
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
export interface BrowserBridgeCompanionPackageStatus {
  extensionPath: string | null;
  chromeBuildPath: string | null;
  chromePackagePath: string | null;
  safariWebExtensionPath: string | null;
  safariAppPath: string | null;
  safariPackagePath: string | null;
  releaseManifest: BrowserBridgeCompanionReleaseManifest | null;
}
export type BrowserWorkspaceMode = "cloud" | "desktop" | "web";
export type BrowserWorkspaceTabKind = "internal" | "standard";
export interface BrowserWorkspaceTab {
  id: string;
  title: string;
  url: string;
  partition: string;
  kind?: BrowserWorkspaceTabKind;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
  lastFocusedAt: string | null;
  liveViewUrl?: string | null;
  interactiveLiveViewUrl?: string | null;
  provider?: string | null;
  status?: string | null;
}
export interface BrowserWorkspaceSnapshot {
  mode: BrowserWorkspaceMode;
  tabs: BrowserWorkspaceTab[];
}
export interface OpenBrowserWorkspaceTabRequest {
  url?: string;
  title?: string;
  show?: boolean;
  partition?: string;
  connectorProvider?: string;
  connectorAccountId?: string;
  kind?: BrowserWorkspaceTabKind;
  width?: number;
  height?: number;
}
export interface NavigateBrowserWorkspaceTabRequest {
  id: string;
  url: string;
  partition?: string;
}
//# sourceMappingURL=browser-contracts.d.ts.map
