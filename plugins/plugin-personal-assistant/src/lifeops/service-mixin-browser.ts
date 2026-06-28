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
import {
  BrowserDomain,
  type BrowserDomainDeps,
} from "./domains/browser-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

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

/** @internal */
export function withBrowser<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, BrowserBridgeService> {
  class LifeOpsBrowserServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly browserDomain = new BrowserDomain(this, {
      getBrowserSettingsInternal: (...args) =>
        this.getBrowserSettingsInternal(...args),
      isBrowserPaused: (...args) => this.isBrowserPaused(...args),
      requireBrowserAvailableForActions: (...args) =>
        this.requireBrowserAvailableForActions(...args),
      buildBrowserCompanion: (...args) => this.buildBrowserCompanion(...args),
      recordBrowserAudit: (...args) => this.recordBrowserAudit(...args),
      getWorkflowDefinition: (...args) => this.getWorkflowDefinition(...args),
      recordScreenTimeEvent: (...args) =>
        (
          this as unknown as {
            recordScreenTimeEvent(
              ...a: Parameters<BrowserDomainDeps["recordScreenTimeEvent"]>
            ): ReturnType<BrowserDomainDeps["recordScreenTimeEvent"]>;
          }
        ).recordScreenTimeEvent(...args),
    });

    createBrowserSessionInternal(
      request: CreateLifeOpsBrowserSessionRequest,
    ): Promise<LifeOpsBrowserSession> {
      return this.browserDomain.createBrowserSessionInternal(request);
    }

    getBrowserSettings(): Promise<BrowserBridgeSettings> {
      return this.browserDomain.getBrowserSettings();
    }

    updateBrowserSettings(
      request: UpdateBrowserBridgeSettingsRequest,
    ): Promise<BrowserBridgeSettings> {
      return this.browserDomain.updateBrowserSettings(request);
    }

    listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]> {
      return this.browserDomain.listBrowserCompanions();
    }

    listBrowserTabs(): Promise<BrowserBridgeTabSummary[]> {
      return this.browserDomain.listBrowserTabs();
    }

    getCurrentBrowserPage(): Promise<BrowserBridgePageContext | null> {
      return this.browserDomain.getCurrentBrowserPage();
    }

    syncBrowserState(request: SyncBrowserBridgeStateRequest): Promise<{
      companion: BrowserBridgeCompanionStatus;
      tabs: BrowserBridgeTabSummary[];
      currentPage: BrowserBridgePageContext | null;
    }> {
      return this.browserDomain.syncBrowserState(request);
    }

    createBrowserCompanionPairing(
      request: CreateBrowserBridgeCompanionPairingRequest,
    ): Promise<BrowserBridgeCompanionPairingResponse> {
      return this.browserDomain.createBrowserCompanionPairing(request);
    }

    syncBrowserCompanion(
      companionId: string,
      pairingToken: string,
      request: SyncBrowserBridgeStateRequest,
    ): Promise<BrowserBridgeCompanionSyncResponse> {
      return this.browserDomain.syncBrowserCompanion(
        companionId,
        pairingToken,
        request,
      );
    }

    listBrowserSessions(): Promise<LifeOpsBrowserSession[]> {
      return this.browserDomain.listBrowserSessions();
    }

    getBrowserSession(sessionId: string): Promise<LifeOpsBrowserSession> {
      return this.browserDomain.getBrowserSession(sessionId);
    }

    createBrowserSession(
      request: CreateLifeOpsBrowserSessionRequest,
    ): Promise<LifeOpsBrowserSession> {
      return this.browserDomain.createBrowserSession(request);
    }

    confirmBrowserSession(
      sessionId: string,
      request: ConfirmLifeOpsBrowserSessionRequest,
    ): Promise<LifeOpsBrowserSession> {
      return this.browserDomain.confirmBrowserSession(sessionId, request);
    }

    completeBrowserSession(
      sessionId: string,
      request: CompleteLifeOpsBrowserSessionRequest,
    ): Promise<LifeOpsBrowserSession> {
      return this.browserDomain.completeBrowserSession(sessionId, request);
    }

    updateBrowserSessionProgress(
      sessionId: string,
      request: UpdateLifeOpsBrowserSessionProgressRequest,
    ): Promise<LifeOpsBrowserSession> {
      return this.browserDomain.updateBrowserSessionProgress(
        sessionId,
        request,
      );
    }

    updateBrowserSessionProgressFromCompanion(
      companionId: string,
      pairingToken: string,
      sessionId: string,
      request: UpdateLifeOpsBrowserSessionProgressRequest,
    ): Promise<LifeOpsBrowserSession> {
      return this.browserDomain.updateBrowserSessionProgressFromCompanion(
        companionId,
        pairingToken,
        sessionId,
        request,
      );
    }

    completeBrowserSessionFromCompanion(
      companionId: string,
      pairingToken: string,
      sessionId: string,
      request: CompleteLifeOpsBrowserSessionRequest,
    ): Promise<LifeOpsBrowserSession> {
      return this.browserDomain.completeBrowserSessionFromCompanion(
        companionId,
        pairingToken,
        sessionId,
        request,
      );
    }

    autoPairBrowserCompanion(
      request: CreateBrowserBridgeCompanionAutoPairRequest,
      apiBaseUrl: string,
    ): Promise<BrowserBridgeCompanionAutoPairResponse> {
      return this.browserDomain.autoPairBrowserCompanion(request, apiBaseUrl);
    }

    revokeBrowserCompanion(
      companionId: string,
    ): Promise<BrowserBridgeCompanionRevokeResponse> {
      return this.browserDomain.revokeBrowserCompanion(companionId);
    }

    revokeBrowserCompanionFromCompanion(
      companionId: string,
      pairingToken: string,
    ): Promise<BrowserBridgeCompanionRevokeResponse> {
      return this.browserDomain.revokeBrowserCompanionFromCompanion(
        companionId,
        pairingToken,
      );
    }
  }

  return LifeOpsBrowserServiceMixin as unknown as MixinClass<
    TBase,
    BrowserBridgeService
  >;
}
