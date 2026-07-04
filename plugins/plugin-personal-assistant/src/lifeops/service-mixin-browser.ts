/**
 * Browser service mixin: declares the LifeOps browser-companion service surface
 * and the `withBrowser` mixin that composes the browser domain's pairing,
 * settings, tab-context, and session methods onto the LifeOpsService base.
 */
import type {
  BrowserBridgeCompanionAutoPairResponse,
  BrowserBridgeCompanionPairingResponse,
  BrowserBridgeCompanionRevokeResponse,
  BrowserBridgeCompanionStatus,
  BrowserBridgeCompanionSyncResponse,
  BrowserBridgePageContext,
  BrowserBridgeSettings,
  BrowserBridgeTabSummary,
  CreateBrowserBridgeCompanionAutoPairRequest,
  CreateBrowserBridgeCompanionPairingRequest,
  SyncBrowserBridgeStateRequest,
  UpdateBrowserBridgeSettingsRequest,
} from "@elizaos/plugin-browser";
import type {
  CompleteLifeOpsBrowserSessionRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserSessionRequest,
  LifeOpsBrowserSession,
  UpdateLifeOpsBrowserSessionProgressRequest,
} from "../contracts/index.js";

export interface BrowserBridgeService {
  getBrowserSettings(): Promise<BrowserBridgeSettings>;
  updateBrowserSettings(
    request: UpdateBrowserBridgeSettingsRequest,
  ): Promise<BrowserBridgeSettings>;
  listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]>;
  listBrowserTabs(): Promise<BrowserBridgeTabSummary[]>;
  getCurrentBrowserPage(): Promise<BrowserBridgePageContext | null>;
  syncBrowserState(request: SyncBrowserBridgeStateRequest): Promise<{
    companion: BrowserBridgeCompanionStatus;
    tabs: BrowserBridgeTabSummary[];
    currentPage: BrowserBridgePageContext | null;
  }>;
  createBrowserCompanionPairing(
    request: CreateBrowserBridgeCompanionPairingRequest,
  ): Promise<BrowserBridgeCompanionPairingResponse>;
  syncBrowserCompanion(
    companionId: string,
    pairingToken: string,
    request: SyncBrowserBridgeStateRequest,
  ): Promise<BrowserBridgeCompanionSyncResponse>;
  listBrowserSessions(): Promise<LifeOpsBrowserSession[]>;
  getBrowserSession(sessionId: string): Promise<LifeOpsBrowserSession>;
  createBrowserSession(
    request: CreateLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession>;
  confirmBrowserSession(
    sessionId: string,
    request: ConfirmLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession>;
  completeBrowserSession(
    sessionId: string,
    request: CompleteLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession>;
  updateBrowserSessionProgressFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: UpdateLifeOpsBrowserSessionProgressRequest,
  ): Promise<LifeOpsBrowserSession>;
  completeBrowserSessionFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: CompleteLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession>;
  autoPairBrowserCompanion(
    request: CreateBrowserBridgeCompanionAutoPairRequest,
    apiBaseUrl: string,
  ): Promise<BrowserBridgeCompanionAutoPairResponse>;
  revokeBrowserCompanion(
    companionId: string,
  ): Promise<BrowserBridgeCompanionRevokeResponse>;
  revokeBrowserCompanionFromCompanion(
    companionId: string,
    pairingToken: string,
  ): Promise<BrowserBridgeCompanionRevokeResponse>;
  updateBrowserSessionProgress(
    sessionId: string,
    request: UpdateLifeOpsBrowserSessionProgressRequest,
  ): Promise<LifeOpsBrowserSession>;
}

// ---------------------------------------------------------------------------
// Browser mixin
// ---------------------------------------------------------------------------
