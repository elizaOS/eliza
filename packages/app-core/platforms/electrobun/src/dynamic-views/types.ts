import type { JsonValue } from "@elizaos/plugin-remote-manifest";

export type DynamicViewId = string;
export type DynamicViewSessionId = string;

export type DynamicViewPlacement =
  | "canvas"
  | "floating"
  | "panel"
  | "chat-inline"
  | "tray"
  | "debug";

export type DynamicViewSource =
  | "agent"
  | "plugin"
  | "remote"
  | "system"
  | "developer";

export type DynamicViewMetadata = Record<string, JsonValue>;

export interface DynamicViewEventSubscription {
  remoteId: string;
  events?: string[];
}

export interface DynamicViewManifest {
  id: DynamicViewId;
  title: string;
  description?: string;
  source: DynamicViewSource;
  entrypoint: string;
  placement: DynamicViewPlacement;
  permissions?: string[];
  requiredRemotes?: string[];
  eventSubscriptions?: DynamicViewEventSubscription[];
  invokeTargets?: string[];
  metadata?: DynamicViewMetadata;
}

export type DynamicViewSessionStatus =
  | "opening"
  | "open"
  | "hidden"
  | "closed"
  | "error";

export interface DynamicViewSession {
  sessionId: DynamicViewSessionId;
  viewId: DynamicViewId;
  title: string;
  placement: DynamicViewPlacement;
  status: DynamicViewSessionStatus;
  canvasWindowId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  error?: string;
  metadata?: DynamicViewMetadata;
}

export interface DynamicViewOpenParams {
  viewId: DynamicViewId;
  title?: string;
  placement?: DynamicViewPlacement;
  initialState?: JsonValue;
  metadata?: DynamicViewMetadata;
}

export interface DynamicViewPushParams {
  sessionId: DynamicViewSessionId;
  event: string;
  payload?: JsonValue;
}

export interface DynamicViewCloseParams {
  sessionId: DynamicViewSessionId;
}

export interface DynamicViewRegisterParams {
  manifest: DynamicViewManifest;
  update?: boolean;
}

export interface DynamicViewUnregisterParams {
  viewId: DynamicViewId;
}

export const DYNAMIC_VIEW_PLACEMENTS: readonly DynamicViewPlacement[] = [
  "canvas",
  "floating",
  "panel",
  "chat-inline",
  "tray",
  "debug",
] as const;

export const DYNAMIC_VIEW_SOURCES: readonly DynamicViewSource[] = [
  "agent",
  "plugin",
  "remote",
  "system",
  "developer",
] as const;
