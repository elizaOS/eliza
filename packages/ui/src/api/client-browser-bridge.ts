/**
 * ElizaClient extension for the policy-controlled browser bridge session
 * surface (`/api/browser-bridge/*`): listing agent browser sessions, reading
 * and updating the bridge domain-policy settings, and confirming or declining
 * a session that is awaiting user takeover. The wire shapes mirror the
 * plugin-browser route contracts; no transformation happens here.
 */
import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgeSettings,
  UpdateBrowserBridgeSettingsRequest,
} from "./browser-contracts";
import { ElizaClient } from "./client-base";

export const BROWSER_BRIDGE_SESSION_STATUSES = [
  "awaiting_confirmation",
  "queued",
  "running",
  "done",
  "cancelled",
  "failed",
] as const;

export type BrowserBridgeSessionStatus =
  (typeof BROWSER_BRIDGE_SESSION_STATUSES)[number];

/** One scripted step inside a bridge session, as persisted by the host plugin. */
export interface BrowserBridgeSessionAction {
  id: string;
  kind: string;
  label: string;
  url: string | null;
  selector: string | null;
  text: string | null;
  accountAffecting: boolean;
  requiresConfirmation: boolean;
  metadata: Record<string, unknown>;
}

/** A policy-controlled agent browser session (wire mirror of the plugin contract). */
export interface BrowserBridgeSession {
  id: string;
  agentId: string;
  domain: string;
  workflowId: string | null;
  browser: string | null;
  companionId: string | null;
  profileId: string | null;
  windowId: string | null;
  tabId: string | null;
  title: string;
  status: BrowserBridgeSessionStatus;
  actions: BrowserBridgeSessionAction[];
  currentActionIndex: number;
  awaitingConfirmationForActionId: string | null;
  result: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface BrowserBridgeSessionsResponse {
  sessions: BrowserBridgeSession[];
}

export interface BrowserBridgeSettingsResponse {
  settings: BrowserBridgeSettings;
}

export interface BrowserBridgeSessionResponse {
  session: BrowserBridgeSession;
}

export interface BrowserBridgeCompanionsResponse {
  companions: BrowserBridgeCompanionStatus[];
}

export interface BrowserBridgeCompanionResetResponse {
  companion: BrowserBridgeCompanionStatus;
  resetAt: string;
}

declare module "./client-base" {
  interface ElizaClient {
    listBrowserBridgeSessions(): Promise<BrowserBridgeSessionsResponse>;
    getBrowserBridgeSettings(): Promise<BrowserBridgeSettingsResponse>;
    updateBrowserBridgeSettings(
      request: UpdateBrowserBridgeSettingsRequest,
    ): Promise<BrowserBridgeSettingsResponse>;
    confirmBrowserBridgeSession(
      id: string,
      confirmed: boolean,
    ): Promise<BrowserBridgeSessionResponse>;
    listBrowserBridgeCompanions(): Promise<BrowserBridgeCompanionsResponse>;
    resetBrowserBridgeCompanionRevocation(
      id: string,
    ): Promise<BrowserBridgeCompanionResetResponse>;
  }
}

ElizaClient.prototype.listBrowserBridgeSessions = async function (
  this: ElizaClient,
): Promise<BrowserBridgeSessionsResponse> {
  return this.fetch<BrowserBridgeSessionsResponse>(
    "/api/browser-bridge/sessions",
  );
};

ElizaClient.prototype.getBrowserBridgeSettings = async function (
  this: ElizaClient,
): Promise<BrowserBridgeSettingsResponse> {
  return this.fetch<BrowserBridgeSettingsResponse>(
    "/api/browser-bridge/settings",
  );
};

ElizaClient.prototype.updateBrowserBridgeSettings = async function (
  this: ElizaClient,
  request: UpdateBrowserBridgeSettingsRequest,
): Promise<BrowserBridgeSettingsResponse> {
  return this.fetch<BrowserBridgeSettingsResponse>(
    "/api/browser-bridge/settings",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
};

ElizaClient.prototype.confirmBrowserBridgeSession = async function (
  this: ElizaClient,
  id: string,
  confirmed: boolean,
): Promise<BrowserBridgeSessionResponse> {
  return this.fetch<BrowserBridgeSessionResponse>(
    `/api/browser-bridge/sessions/${encodeURIComponent(id)}/confirm`,
    {
      method: "POST",
      body: JSON.stringify({ confirmed }),
    },
  );
};

ElizaClient.prototype.listBrowserBridgeCompanions = async function (
  this: ElizaClient,
): Promise<BrowserBridgeCompanionsResponse> {
  return this.fetch<BrowserBridgeCompanionsResponse>(
    "/api/browser-bridge/companions",
  );
};

ElizaClient.prototype.resetBrowserBridgeCompanionRevocation = async function (
  this: ElizaClient,
  id: string,
): Promise<BrowserBridgeCompanionResetResponse> {
  return this.fetch<BrowserBridgeCompanionResetResponse>(
    `/api/browser-bridge/companions/${encodeURIComponent(id)}/reset-revocation`,
    { method: "POST" },
  );
};
