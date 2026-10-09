/** Defines legacy browser history records shared with LifeOps storage and session readers. These contracts do not enable companion enrollment or execution. */

import type { LifeOpsBrowserSession } from "./lifeops-session-contracts.js";

export const BROWSER_BRIDGE_KINDS = ["chrome", "firefox", "safari"] as const;
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
  pairingKind?: "manual" | "native_enrollment";
  metadata?: Record<string, unknown>;
}

export interface BrowserBridgeCompanionPairingResponse {
  companion: BrowserBridgeCompanionStatus;
  pairingToken: string;
  pairingTokenExpiresAt: string | null;
}

export interface BrowserBridgeCompanionRevocationResetResponse {
  companion: BrowserBridgeCompanionStatus;
  resetAt: string;
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

export interface BrowserBridgeCompanionPreflightRequest {
  companion: UpsertBrowserBridgeCompanionRequest;
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

export interface BrowserBridgeCompanionSyncResponse {
  companion: BrowserBridgeCompanionStatus;
  tabs: BrowserBridgeTabSummary[];
  currentPage: BrowserBridgePageContext | null;
  settings: BrowserBridgeSettings;
  settingsVersion: string;
  session: LifeOpsBrowserSession | null;
}

export interface UpdateBrowserBridgeSessionProgressRequest {
  currentActionIndex?: number;
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface BrowserBridgeCompanionSessionProgressRequest
  extends UpdateBrowserBridgeSessionProgressRequest {
  completedActionId: string;
  attemptId: string;
}

export interface BrowserBridgeCompanionSessionBeginRequest {
  currentActionIndex: number;
  actionId: string;
  attemptId: string;
}
