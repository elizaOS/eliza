/** Declares the legacy browser history and stored-session surface used by LifeOps. New automation uses the browser workspace action. */

import type {
  CompleteLifeOpsBrowserSessionRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserSessionRequest,
  LifeOpsBrowserSession,
  UpdateLifeOpsBrowserSessionProgressRequest,
} from "@elizaos/contracts";
import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgePageContext,
  BrowserBridgeSettings,
  BrowserBridgeTabSummary,
  UpdateBrowserBridgeSettingsRequest,
} from "@elizaos/plugin-browser";

export interface BrowserBridgeService {
  getBrowserSettings(): Promise<BrowserBridgeSettings>;
  updateBrowserSettings(
    request: UpdateBrowserBridgeSettingsRequest,
  ): Promise<BrowserBridgeSettings>;
  listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]>;
  listBrowserTabs(): Promise<BrowserBridgeTabSummary[]>;
  getCurrentBrowserPage(): Promise<BrowserBridgePageContext | null>;
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
  updateBrowserSessionProgress(
    sessionId: string,
    request: UpdateLifeOpsBrowserSessionProgressRequest,
  ): Promise<LifeOpsBrowserSession>;
}

// ---------------------------------------------------------------------------
// Browser mixin
// ---------------------------------------------------------------------------
