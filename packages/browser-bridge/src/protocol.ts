import type {
  BrowserBridgeCompanionAutoPairResponse,
  BrowserBridgeCompanionConfig,
  BrowserBridgeSettings,
  CreateBrowserBridgeCompanionAutoPairRequest,
  SyncBrowserBridgeStateRequest,
  UpdateBrowserBridgeSessionProgressRequest,
} from "@elizaos/plugin-browser";
import type {
  CompleteLifeOpsBrowserSessionRequest,
  LifeOpsBrowserSession,
} from "@elizaos/shared/contracts/lifeops";

export type CompanionSyncRequest = SyncBrowserBridgeStateRequest;
export type CompanionSession = LifeOpsBrowserSession;
export type CompanionSessionProgressRequest =
  UpdateBrowserBridgeSessionProgressRequest;
export type CompanionSessionCompleteRequest =
  CompleteLifeOpsBrowserSessionRequest;
export type CompanionConfig = BrowserBridgeCompanionConfig;
export type CompanionAutoPairRequest =
  CreateBrowserBridgeCompanionAutoPairRequest;
export type CompanionAutoPairResponse = BrowserBridgeCompanionAutoPairResponse;

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
};

export type PopupRequest =
  | { type: "browser-bridge:get-state" }
  | { type: "browser-bridge:sync-now" }
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
};

export type ExecuteDomActionMessage = {
  type: "browser-bridge:execute-dom-action";
  action: {
    kind: "click" | "type" | "submit" | "history_back" | "history_forward";
    selector?: string | null;
    text?: string | null;
  };
};

export type ContentScriptMessage = CapturePageMessage | ExecuteDomActionMessage;

export type ContentScriptResponse =
  | {
      ok: true;
      page?: {
        url: string;
        title: string;
        selectionText: string | null;
        mainText: string | null;
        headings: string[];
        links: Array<{ text: string; href: string }>;
        forms: Array<{ action: string | null; fields: string[] }>;
        capturedAt: string;
      };
      actionResult?: Record<string, unknown>;
    }
  | { ok: false; error: string };
