/**
 * Runtime message contracts exchanged between the extension's contexts —
 * popup UI, background service worker, and content script — plus the
 * companion-sync aliases from the local browser-bridge wire contracts.
 * Type-only; no runtime code.
 */
import type {
  BrowserBridgeCompanionConfig,
  BrowserBridgeCompanionPreflightRequest,
  BrowserBridgeCompanionSessionBeginRequest,
  BrowserBridgeCompanionSessionProgressRequest,
  BrowserBridgeCompanionSyncRequest,
  BrowserBridgeSettings,
  CompleteLifeOpsBrowserSessionRequest,
  LifeOpsBrowserSession,
} from "./browser-bridge-contracts";

export type CompanionPreflightRequest = BrowserBridgeCompanionPreflightRequest;
export type CompanionSyncRequest = BrowserBridgeCompanionSyncRequest;
export type CompanionSession = LifeOpsBrowserSession;
export type CompanionSessionBeginRequest =
  BrowserBridgeCompanionSessionBeginRequest;
export type CompanionSessionProgressRequest =
  BrowserBridgeCompanionSessionProgressRequest;
export type CompanionSessionCompleteRequest =
  CompleteLifeOpsBrowserSessionRequest;
export type CompanionConfig = BrowserBridgeCompanionConfig;

export type BackgroundState = {
  config: CompanionConfig | null;
  settings: BrowserBridgeSettings | null;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  lastSessionStatus: string | null;
  activeSessionId: string | null;
  rememberedTabCount: number;
  settingsSummary: string | null;
  connectionIssue:
    | "app_not_running"
    | "app_not_authenticated"
    | "recovery_required"
    | null;
};

export type PopupRequest =
  | { type: "browser-bridge:get-state" }
  | { type: "browser-bridge:sync-now" }
  | { type: "browser-bridge:owner-reconnect" }
  | { type: "browser-bridge:auto-pair" }
  | {
      type: "browser-bridge:save-config";
      config: Partial<CompanionConfig>;
    }
  | { type: "browser-bridge:clear-config" };

export type PopupResponse =
  | { ok: true; state: BackgroundState }
  | { ok: false; error: string; state?: BackgroundState };

export type CapturePageMessage = {
  type: "browser-bridge:capture-page";
  expectedUrl: string;
};

export type PageContextSnapshot = {
  url: string;
  title: string;
  selectionText: string | null;
  mainText: string | null;
  headings: string[];
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string | null; fields: string[] }>;
  capturedAt: string;
};

export type DomActionRequest = {
  kind: "click" | "type" | "submit" | "history_back" | "history_forward";
  selector?: string | null;
  text?: string | null;
};

export type ExecuteDomActionMessage = {
  type: "browser-bridge:execute-dom-action";
  expectedUrl: string;
  action: DomActionRequest;
};

export type ContentScriptMessage = CapturePageMessage | ExecuteDomActionMessage;

export type ContentScriptResponse =
  | {
      ok: true;
      page?: PageContextSnapshot;
      actionResult?: Record<string, unknown>;
    }
  | { ok: false; error: string };
