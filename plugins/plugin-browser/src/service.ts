/**
 * Browser bridge route service interface implemented by host plugins.
 */

import type { Service, UUID } from "@elizaos/core";
import type {
  BrowserBridgeCompanionPairingResponse,
  BrowserBridgeCompanionPreflightRequest,
  BrowserBridgeCompanionPreflightResponse,
  BrowserBridgeCompanionRevocationResetResponse,
  BrowserBridgeCompanionRevokeResponse,
  BrowserBridgeCompanionSessionBeginRequest,
  BrowserBridgeCompanionSessionProgressRequest,
  BrowserBridgeCompanionStatus,
  BrowserBridgeCompanionSyncRequest,
  BrowserBridgeCompanionSyncResponse,
  BrowserBridgePageContext,
  BrowserBridgeSettings,
  BrowserBridgeTabSummary,
  CreateBrowserBridgeCompanionPairingRequest,
  SyncBrowserBridgeStateRequest,
  UpdateBrowserBridgeSessionProgressRequest,
  UpdateBrowserBridgeSettingsRequest,
} from "./contracts.js";
import type {
  CompleteLifeOpsBrowserSessionRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserSessionRequest,
  LifeOpsBrowserSession,
} from "./lifeops-session-contracts.js";

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
  revokeBrowserCompanion(
    companionId: string,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionRevokeResponse>;
  resetBrowserCompanionRevocation(
    companionId: string,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionRevocationResetResponse>;
  revokeBrowserCompanionFromCompanion(
    companionId: string,
    pairingToken: string,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionRevokeResponse>;
  syncBrowserCompanion(
    companionId: string,
    pairingToken: string,
    request: BrowserBridgeCompanionSyncRequest,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionSyncResponse>;
  preflightBrowserCompanion(
    companionId: string,
    pairingToken: string,
    request: BrowserBridgeCompanionPreflightRequest,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionPreflightResponse>;
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
    request: BrowserBridgeCompanionSessionProgressRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession>;
  beginBrowserSessionActionFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: BrowserBridgeCompanionSessionBeginRequest,
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
