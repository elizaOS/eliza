/**
 * Data contracts shared between the extension and the agent's
 * `/api/browser-bridge/*` routes: bridge settings, action kinds, and the sync
 * request/response shapes. Both sides depend on these types to agree on the
 * wire format; type-only, no runtime code.
 */
export type BrowserBridgeKind = "chrome" | "firefox" | "safari";

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

export type BrowserBridgeActionKind =
  | "open"
  | "navigate"
  | "focus_tab"
  | "back"
  | "forward"
  | "reload"
  | "click"
  | "type"
  | "submit"
  | "read_page"
  | "extract_links"
  | "extract_forms";

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
    links?: Array<{ text: string; href: string }>;
    forms?: Array<{ action: string | null; fields: string[] }>;
    capturedAt?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface BrowserBridgeCompanionPreflightRequest {
  companion: SyncBrowserBridgeStateRequest["companion"];
}

export interface BrowserBridgeCompanionSyncRequest
  extends SyncBrowserBridgeStateRequest {
  settingsVersion: string;
}

export interface BrowserBridgeCompanionPreflightResponse {
  companion: BrowserBridgeCompanionStatus;
  settings: BrowserBridgeSettings;
  settingsVersion: string;
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

export interface UpdateBrowserBridgeSessionProgressRequest {
  currentActionIndex?: number;
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface BrowserBridgeCompanionSessionProgressRequest
  extends UpdateBrowserBridgeSessionProgressRequest {
  completedActionId: string;
}

export type LifeOpsBrowserSessionStatus =
  | "awaiting_confirmation"
  | "queued"
  | "running"
  | "done"
  | "cancelled"
  | "failed";

export interface LifeOpsBrowserSession {
  id: string;
  agentId: string;
  domain: string;
  subjectType: string;
  subjectId: string;
  visibilityScope: string;
  contextPolicy: string;
  workflowId: string | null;
  browser: BrowserBridgeKind | null;
  companionId: string | null;
  profileId: string | null;
  windowId: string | null;
  tabId: string | null;
  title: string;
  status: LifeOpsBrowserSessionStatus;
  actions: BrowserBridgeAction[];
  currentActionIndex: number;
  awaitingConfirmationForActionId: string | null;
  result: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface CompleteLifeOpsBrowserSessionRequest {
  status?: Extract<LifeOpsBrowserSessionStatus, "done" | "failed">;
  result?: Record<string, unknown>;
}

export interface BrowserBridgeCompanionSyncResponse {
  companion: BrowserBridgeCompanionStatus;
  tabs: Array<Record<string, unknown>>;
  currentPage: Record<string, unknown> | null;
  settings: BrowserBridgeSettings;
  settingsVersion: string;
  session: LifeOpsBrowserSession | null;
}
