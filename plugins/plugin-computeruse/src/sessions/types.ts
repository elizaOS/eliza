/** Defines the fail-closed lifecycle and event contract for isolated computer-use sessions. */

export type ComputerUseSessionTargetKind =
  | "host"
  | "browser"
  | "sandbox"
  | "remote_guest";

export interface ComputerUseSessionTarget {
  kind: ComputerUseSessionTargetKind;
  /** Stable adapter-owned identifier. Host sessions omit this field. */
  targetId?: string;
  /** Optional viewer endpoint with credentials, query, and fragment removed. */
  viewerUrl?: string;
}

export type ComputerUseSessionStatus = "idle" | "running" | "closed";

export interface ComputerUseVirtualCursor {
  x: number;
  y: number;
  displayId?: number;
  updatedAt: string;
}

export interface ComputerUseSessionSnapshot {
  id: string;
  label: string;
  target: ComputerUseSessionTarget;
  status: ComputerUseSessionStatus;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  leaseExpiresAt?: string;
  cursor?: ComputerUseVirtualCursor;
  activeActionId?: string;
  lastActionId?: string;
  lastCommand?: string;
  lastError?: string;
}

export interface CreateComputerUseSessionInput {
  label?: string;
  target: ComputerUseSessionTarget;
  /** Host-only lease duration. The manager clamps this to its configured bounds. */
  leaseTtlMs?: number;
}

export interface ComputerUseSessionAction {
  actionId: string;
  expectedSequence: number;
  command: string;
  parameters?: Record<string, unknown>;
}

export interface ComputerUseSessionActionResult {
  success: boolean;
  error?: string;
  cursorPosition?: { x: number; y: number };
  displayId?: number;
}

export interface ComputerUseSessionFrame {
  mimeType: "image/png" | "image/jpeg";
  /** Raw base64 bytes. This value is returned only by the frame endpoint. */
  data: string;
  capturedAt: string;
  width?: number;
  height?: number;
}

export type ComputerUseSessionEventType =
  | "session.created"
  | "session.lease_renewed"
  | "session.closed"
  | "action.started"
  | "action.completed"
  | "action.failed";

export interface ComputerUseSessionEvent {
  eventId: number;
  type: ComputerUseSessionEventType;
  sessionId: string;
  sessionSequence: number;
  occurredAt: string;
  actionId?: string;
  command?: string;
  error?: string;
  snapshot: ComputerUseSessionSnapshot;
}

export type ComputerUseSessionExecutor = (
  target: ComputerUseSessionTarget,
  action: ComputerUseSessionAction,
) => Promise<ComputerUseSessionActionResult>;

export type ComputerUseSessionFrameProvider = (
  target: ComputerUseSessionTarget,
) => Promise<Omit<ComputerUseSessionFrame, "capturedAt">>;
