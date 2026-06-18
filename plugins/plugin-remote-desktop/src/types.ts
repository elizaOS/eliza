/**
 * Public types for @elizaos/plugin-remote-desktop.
 *
 * Canonical home for the remote-desktop type contract. The engine
 * (`src/lifeops/remote-desktop.ts`) and the control-plane service
 * (`src/remote/remote-session-service.ts`) import and re-export these.
 */

export type RemoteDesktopBackend =
  | "tailscale-vnc"
  | "tailscale-ssh"
  | "ngrok-vnc"
  | "none";

export type RemoteDesktopSessionStatus =
  | "starting"
  | "active"
  | "ended"
  | "failed";

export interface RemoteDesktopSession {
  id: string;
  backend: RemoteDesktopBackend;
  status: RemoteDesktopSessionStatus;
  accessUrl?: string;
  accessCode?: string;
  startedAt: string;
  endedAt?: string;
  expiresAt?: string;
  error?: string;
  mockMode?: boolean;
}

export interface RemoteDesktopConfig {
  preferredBackend?: RemoteDesktopBackend;
  tailscaleNodeName?: string;
  ngrokAuthToken?: string;
  vncPort?: number;
  sessionDurationMinutes?: number;
}

export type RemoteSessionStatus = "pending" | "active" | "denied" | "revoked";

export type DataPlaneUnavailableReason =
  | "data-plane-not-configured"
  | "local-mode-no-ingress";

export interface RemoteSession {
  id: string;
  requesterIdentity: string;
  status: RemoteSessionStatus;
  ingressUrl: string | null;
  reason: DataPlaneUnavailableReason | null;
  localMode: boolean;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface StartSessionParams {
  requesterIdentity: string;
  pairingCode?: string | undefined;
  confirmed: boolean;
}

export interface StartSessionResult {
  sessionId: string;
  status: RemoteSessionStatus;
  ingressUrl: string | null;
  reason: DataPlaneUnavailableReason | null;
  localMode: boolean;
}

/**
 * Subaction names accepted by the REMOTE_DESKTOP umbrella action.
 */
export type RemoteDesktopSubaction =
  | "start"
  | "status"
  | "end"
  | "list"
  | "revoke";

/**
 * Parameter envelope passed to the REMOTE_DESKTOP handler.
 */
export interface RemoteDesktopActionParams {
  sessionId?: string;
  confirmed?: boolean;
  pairingCode?: string;
  requesterIdentity?: string;
  intent?: string;
}
