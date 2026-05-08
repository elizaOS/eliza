import { type IAgentRuntime, Service, type UUID } from "@elizaos/core";
import {
  BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  type BrowserBridgeCompanionAutoPairResponse,
  type BrowserBridgeCompanionPairingResponse,
  type BrowserBridgeCompanionStatus,
  type BrowserBridgeCompanionSyncResponse,
  type BrowserBridgePageContext,
  type BrowserBridgeRouteService,
  type BrowserBridgeSettings,
  type BrowserBridgeTabSummary,
  type CreateBrowserBridgeCompanionAutoPairRequest,
  type CreateBrowserBridgeCompanionPairingRequest,
  type SyncBrowserBridgeStateRequest,
  type UpdateBrowserBridgeSessionProgressRequest,
  type UpdateBrowserBridgeSettingsRequest,
} from "@elizaos/plugin-browser";
import type {
  CompleteLifeOpsBrowserSessionRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserSessionRequest,
  LifeOpsBrowserSession,
} from "@elizaos/shared";
import { LifeOpsService } from "./lifeops/service.js";

export class BrowserBridgePluginService
  extends Service
  implements BrowserBridgeRouteService
{
  static override serviceType = BROWSER_BRIDGE_ROUTE_SERVICE_TYPE;

  capabilityDescription =
    "Surfaces the user's personal Agent Browser Bridge state and creates browser sessions for their Chrome and Safari companions.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<BrowserBridgePluginService> {
    return new BrowserBridgePluginService(runtime);
  }

  private lifeOps(ownerEntityId?: UUID | null): LifeOpsService {
    return new LifeOpsService(this.runtime, {
      ownerEntityId: ownerEntityId ?? null,
    });
  }

  async getBrowserSettings(
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeSettings> {
    return this.lifeOps(ownerEntityId).getBrowserSettings();
  }

  async updateBrowserSettings(
    request: UpdateBrowserBridgeSettingsRequest,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeSettings> {
    return this.lifeOps(ownerEntityId).updateBrowserSettings(request);
  }

  async listBrowserCompanions(
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionStatus[]> {
    return this.lifeOps(ownerEntityId).listBrowserCompanions();
  }

  async listBrowserTabs(
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeTabSummary[]> {
    return this.lifeOps(ownerEntityId).listBrowserTabs();
  }

  async getCurrentBrowserPage(
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgePageContext | null> {
    return this.lifeOps(ownerEntityId).getCurrentBrowserPage();
  }

  async syncBrowserState(
    request: SyncBrowserBridgeStateRequest,
    ownerEntityId?: UUID | null,
  ): Promise<{
    companion: BrowserBridgeCompanionStatus;
    tabs: BrowserBridgeTabSummary[];
    currentPage: BrowserBridgePageContext | null;
  }> {
    return this.lifeOps(ownerEntityId).syncBrowserState(request);
  }

  async createBrowserCompanionPairing(
    request: CreateBrowserBridgeCompanionPairingRequest,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionPairingResponse> {
    return this.lifeOps(ownerEntityId).createBrowserCompanionPairing(request);
  }

  async autoPairBrowserCompanion(
    request: CreateBrowserBridgeCompanionAutoPairRequest,
    apiBaseUrl: string,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionAutoPairResponse> {
    return this.lifeOps(ownerEntityId).autoPairBrowserCompanion(
      request,
      apiBaseUrl,
    );
  }

  async syncBrowserCompanion(
    companionId: string,
    pairingToken: string,
    request: SyncBrowserBridgeStateRequest,
    ownerEntityId?: UUID | null,
  ): Promise<BrowserBridgeCompanionSyncResponse> {
    return this.lifeOps(ownerEntityId).syncBrowserCompanion(
      companionId,
      pairingToken,
      request,
    );
  }

  async listBrowserSessions(
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession[]> {
    return this.lifeOps(ownerEntityId).listBrowserSessions();
  }

  async getBrowserSession(
    sessionId: string,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession> {
    return this.lifeOps(ownerEntityId).getBrowserSession(sessionId);
  }

  async createBrowserSession(
    request: CreateLifeOpsBrowserSessionRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession> {
    return this.lifeOps(ownerEntityId).createBrowserSession(request);
  }

  async confirmBrowserSession(
    sessionId: string,
    request: ConfirmLifeOpsBrowserSessionRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession> {
    return this.lifeOps(ownerEntityId).confirmBrowserSession(
      sessionId,
      request,
    );
  }

  async updateBrowserSessionProgress(
    sessionId: string,
    request: UpdateBrowserBridgeSessionProgressRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession> {
    return this.lifeOps(ownerEntityId).updateBrowserSessionProgress(
      sessionId,
      request,
    );
  }

  async completeBrowserSession(
    sessionId: string,
    request: CompleteLifeOpsBrowserSessionRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession> {
    return this.lifeOps(ownerEntityId).completeBrowserSession(
      sessionId,
      request,
    );
  }

  async updateBrowserSessionProgressFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: UpdateBrowserBridgeSessionProgressRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession> {
    return this.lifeOps(
      ownerEntityId,
    ).updateBrowserSessionProgressFromCompanion(
      companionId,
      pairingToken,
      sessionId,
      request,
    );
  }

  async completeBrowserSessionFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: CompleteLifeOpsBrowserSessionRequest,
    ownerEntityId?: UUID | null,
  ): Promise<LifeOpsBrowserSession> {
    return this.lifeOps(ownerEntityId).completeBrowserSessionFromCompanion(
      companionId,
      pairingToken,
      sessionId,
      request,
    );
  }

  async stop(): Promise<void> {
    // No resources to clean up.
  }
}
