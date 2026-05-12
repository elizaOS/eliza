import type { Service, UUID } from "@elizaos/core";
import type {
  CompleteLifeOpsBrowserSessionRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserSessionRequest,
  LifeOpsBrowserSession,
} from "./lifeops-session-contracts.js";
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
  UpdateBrowserBridgeSessionProgressRequest,
  UpdateBrowserBridgeSettingsRequest,
} from "./contracts.js";

export const BROWSER_BRIDGE_ROUTE_SERVICE_TYPE = "lifeops_browser_plugin";

export interface BrowserBridgeRouteService extends Service {
  getBrowserSettings(
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeSettings>;
  updateBrowserSettings(
    request: UpdateBrowserBridgeSettingsRequest,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeSettings>;
  listBrowserCompanions(
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionStatus[]>;
  listBrowserTabs(
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeTabSummary[]>;
  getCurrentBrowserPage(
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgePageContext | null>;
  syncBrowserState(
    request: SyncBrowserBridgeStateRequest,
    ownerEntityId?: UUID | null,
  ): Promise<{
    companion: BrowserBridgeCompanionStatus;
    tabs: BrowserBridgeTabSummary[];
    currentPage: BrowserBridgePageContext | null;
  }>;
  createBrowserCompanionPairing(
    request: CreateBrowserBridgeCompanionPairingRequest,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionPairingResponse>;
  autoPairBrowserCompanion(
    request: CreateBrowserBridgeCompanionAutoPairRequest,
    apiBaseUrl: string,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionAutoPairResponse>;
  revokeBrowserCompanion(
    companionId: string,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionRevokeResponse>;
  revokeBrowserCompanionFromCompanion(
    companionId: string,
    pairingToken: string,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionRevokeResponse>;
  syncBrowserCompanion(
    companionId: string,
    pairingToken: string,
    request: SyncBrowserBridgeStateRequest,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionSyncResponse>;
  listBrowserSessions(
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession[]>;
  getBrowserSession(
    sessionId: string,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession>;
  createBrowserSession(
    request: CreateLifeOpsBrowserSessionRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession>;
  confirmBrowserSession(
    sessionId: string,
    request: ConfirmLifeOpsBrowserSessionRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession>;
  updateBrowserSessionProgress(
    sessionId: string,
    request: UpdateBrowserBridgeSessionProgressRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession>;
  completeBrowserSession(
    sessionId: string,
    request: CompleteLifeOpsBrowserSessionRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession>;
  updateBrowserSessionProgressFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: UpdateBrowserBridgeSessionProgressRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession>;
  completeBrowserSessionFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: CompleteLifeOpsBrowserSessionRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession>;
}
