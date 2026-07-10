/**
 * Shared pendant status vocabulary for settings and transcript surfaces.
 */

import type { PendantConnectStep } from "./connect-timeout";

export type PendantStatus =
  | "unsupported"
  | "idle"
  | "requesting"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "listening"
  | "hearing"
  | "transcribing"
  | "paused"
  | "error";

export function pendantStatusLabel(status: PendantStatus): string {
  switch (status) {
    case "unsupported":
      return "Not supported in this browser";
    case "idle":
      return "Not connected";
    case "requesting":
      return "Choose a device...";
    case "connecting":
      return "Connecting...";
    case "reconnecting":
      return "Reconnecting...";
    case "connected":
      return "Connected";
    case "listening":
      return "Listening";
    case "hearing":
      return "Hearing you...";
    case "transcribing":
      return "Transcribing...";
    case "paused":
      return "Paused";
    case "error":
      return "Connection error";
  }
}

export function pendantConnectStepLabel(
  step: PendantConnectStep,
): string | null {
  switch (step) {
    case "gatt-connect":
      return "linking GATT";
    case "audio-service":
      return "finding audio service";
    case "codec-read":
      return "reading codec";
    case "decoder-init":
      return "loading decoder";
    case "audio-char":
      return "finding audio channel";
    case "start-notifications":
      return "subscribing to audio";
    case "battery":
      return "reading battery";
    case "idle":
    case "done":
      return null;
  }
}

export function isPendantLiveStatus(status: PendantStatus): boolean {
  return (
    status === "connected" ||
    status === "listening" ||
    status === "hearing" ||
    status === "transcribing" ||
    status === "paused"
  );
}
