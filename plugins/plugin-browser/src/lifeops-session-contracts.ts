import type { BrowserBridgeAction, BrowserBridgeKind } from "./contracts.js";

export type LifeOpsBrowserSessionStatus =
  | "awaiting_confirmation"
  | "queued"
  | "running"
  | "done"
  | "cancelled"
  | "failed";

export interface LifeOpsBrowserSession {
  id: string;
  agentId: string;
  domain: string;
  subjectType: string;
  subjectId: string;
  visibilityScope: string;
  contextPolicy: string;
  workflowId: string | null;
  browser: BrowserBridgeKind | null;
  companionId: string | null;
  profileId: string | null;
  windowId: string | null;
  tabId: string | null;
  title: string;
  status: LifeOpsBrowserSessionStatus;
  actions: BrowserBridgeAction[];
  currentActionIndex: number;
  awaitingConfirmationForActionId: string | null;
  result: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface CreateLifeOpsBrowserSessionRequest {
  ownership?: Record<string, unknown>;
  workflowId?: string | null;
  browser?: BrowserBridgeKind | null;
  companionId?: string | null;
  profileId?: string | null;
  windowId?: string | null;
  tabId?: string | null;
  title: string;
  actions: Array<Omit<BrowserBridgeAction, "id">>;
}

export interface ConfirmLifeOpsBrowserSessionRequest {
  confirmed: boolean;
}

export interface CompleteLifeOpsBrowserSessionRequest {
  status?: Extract<LifeOpsBrowserSessionStatus, "done" | "failed">;
  result?: Record<string, unknown>;
}
