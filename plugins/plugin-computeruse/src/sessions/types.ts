/** Defines the v2-compatible lifecycle, observation provenance, and event contract for computer-use sessions. */

import type {
  InteractionIsolationMode,
  InteractionOutcomeStatus,
  InteractionSessionState,
} from "@elizaos/core";

export const COMPUTER_USE_INTERACTION_CONTRACT_VERSION = 2 as const;

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

export type ComputerUseSessionStatus =
  | "idle"
  | "running"
  | "paused"
  | "stopping"
  | "closed";

export interface ComputerUseObservationProvenance {
  observationId: string;
  sequence: number;
  observedAt: string;
  sha256: string;
  mimeType: "image/png" | "image/jpeg";
  width?: number;
  height?: number;
  source: "host" | "browser" | "sandbox" | "remote_guest";
}

export interface ComputerUseSessionOutcome {
  actionId: string;
  status: InteractionOutcomeStatus;
  completedAt: string;
  observationId?: string;
  errorCode?: string;
}

export interface ComputerUseVirtualCursor {
  x: number;
  y: number;
  displayId?: number;
  updatedAt: string;
}

export interface ComputerUseSessionSnapshot {
  contractVersion: typeof COMPUTER_USE_INTERACTION_CONTRACT_VERSION;
  id: string;
  ownerId: string;
  adapterId: string;
  canonicalState: InteractionSessionState;
  isolationMode: InteractionIsolationMode;
  generation: number;
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
  lastObservation?: ComputerUseObservationProvenance;
  lastOutcome?: ComputerUseSessionOutcome;
}

export interface CreateComputerUseSessionInput {
  /** Stable owner identity used by the canonical interaction authority. */
  ownerId?: string;
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
  /** Fresh observation binding required for every consequential action. */
  observationId?: string;
  observationSequence?: number;
}

export interface ComputerUseSessionActionResult {
  success: boolean;
  error?: string;
  errorCode?: string;
  outcomeStatus?: InteractionOutcomeStatus;
  permissionDenied?: boolean;
  permissionType?: string;
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
  provenance: ComputerUseObservationProvenance;
}

export type ComputerUseSessionEventType =
  | "session.created"
  | "session.lease_renewed"
  | "session.paused"
  | "session.resumed"
  | "session.stopping"
  | "session.closed"
  | "observation.captured"
  | "action.started"
  | "action.completed"
  | "action.failed"
  | "action.blocked";

export interface ComputerUseSessionEvent {
  eventId: number;
  type: ComputerUseSessionEventType;
  sessionId: string;
  sessionSequence: number;
  occurredAt: string;
  actionId?: string;
  command?: string;
  error?: string;
  observationId?: string;
  outcomeStatus?: InteractionOutcomeStatus;
  snapshot: ComputerUseSessionSnapshot;
}

export type ComputerUseSessionExecutor = (
  target: ComputerUseSessionTarget,
  action: ComputerUseSessionAction,
  signal?: AbortSignal,
) => Promise<ComputerUseSessionActionResult>;

export type ComputerUseSessionFrameProvider = (
  target: ComputerUseSessionTarget,
  signal?: AbortSignal,
) => Promise<Omit<ComputerUseSessionFrame, "capturedAt" | "provenance">>;
