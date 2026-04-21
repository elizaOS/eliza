import type {
  CreateLifeOpsBrowserCompanionAutoPairRequest,
  CompleteLifeOpsBrowserSessionRequest,
  LifeOpsBrowserCompanionAutoPairResponse,
  LifeOpsBrowserCompanionConfig,
  LifeOpsBrowserKind,
  LifeOpsBrowserSession,
  LifeOpsBrowserSettings,
  SyncLifeOpsBrowserStateRequest,
  UpdateLifeOpsBrowserSessionProgressRequest,
} from "@elizaos/app-lifeops/contracts";

export type CompanionSyncRequest = SyncLifeOpsBrowserStateRequest;
export type CompanionSession = LifeOpsBrowserSession;
export type CompanionSessionProgressRequest =
  UpdateLifeOpsBrowserSessionProgressRequest;
export type CompanionSessionCompleteRequest =
  CompleteLifeOpsBrowserSessionRequest;
export type CompanionConfig = LifeOpsBrowserCompanionConfig;
export type CompanionAutoPairRequest =
  CreateLifeOpsBrowserCompanionAutoPairRequest;
export type CompanionAutoPairResponse =
  LifeOpsBrowserCompanionAutoPairResponse;

export type BackgroundState = {
  config: CompanionConfig | null;
  settings: LifeOpsBrowserSettings | null;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  lastSessionStatus: string | null;
  activeSessionId: string | null;
  rememberedTabCount: number;
  settingsSummary: string | null;
};

export type PopupRequest =
  | { type: "lifeops-browser:get-state" }
  | { type: "lifeops-browser:sync-now" }
  | { type: "lifeops-browser:auto-pair" }
  | {
      type: "lifeops-browser:save-config";
      config: Partial<CompanionConfig>;
    }
  | { type: "lifeops-browser:clear-config" };

export type PopupResponse =
  | { ok: true; state: BackgroundState }
  | { ok: false; error: string; state?: BackgroundState };

export type CapturePageMessage = {
  type: "lifeops-browser:capture-page";
};

export type ExecuteDomActionMessage = {
  type: "lifeops-browser:execute-dom-action";
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
