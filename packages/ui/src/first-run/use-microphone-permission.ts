import type { PermissionStatus } from "@elizaos/shared";
import * as React from "react";
import { client } from "../api";

/**
 * Microphone permission for voice-first onboarding.
 *
 * Wraps the cross-platform permission client (`client.requestPermission` /
 * `client.openPermissionSettings`, which route to Electrobun RPC on desktop,
 * Capacitor on iOS/Android, and `getUserMedia`/`Notification` on web). When
 * those client methods are unavailable in the current renderer, it degrades to
 * a plain `getUserMedia({ audio: true })` probe so the prompt still surfaces.
 *
 * None of these paths throw: every failure resolves to a concrete state so the
 * onboarding UI can always render an actionable affordance.
 */

const MICROPHONE = "microphone" as const;

export type MicrophonePermissionStatus = PermissionStatus | "unknown";

export interface MicrophonePermissionState {
  status: MicrophonePermissionStatus;
  /** Whether the OS-level request can be re-triggered (false once denied). */
  canRequest: boolean;
  /** True while a request is in flight. */
  requesting: boolean;
}

export interface MicrophonePermissionController
  extends MicrophonePermissionState {
  /** Prompt the OS for microphone access and reflect the resulting state. */
  request: () => Promise<void>;
  /** Open OS settings so a denied permission can be granted manually. */
  openSettings: () => Promise<void>;
}

function hasClientPermissionApi(): boolean {
  return (
    typeof client.requestPermission === "function" &&
    typeof client.openPermissionSettings === "function"
  );
}

/**
 * Fallback path when the permission client is unavailable: a bare
 * `getUserMedia` probe. A granted stream is stopped immediately (we only want
 * the permission, not the audio). A rejection means denied/blocked.
 */
async function probeMicrophoneViaGetUserMedia(): Promise<MicrophonePermissionStatus> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.mediaDevices?.getUserMedia !== "function"
  ) {
    return "not-applicable";
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return "granted";
  } catch {
    return "denied";
  }
}

async function openMicrophoneSettingsViaClient(): Promise<void> {
  if (typeof client.openPermissionSettings !== "function") return;
  try {
    await client.openPermissionSettings(MICROPHONE);
  } catch {
    // Opening OS settings is best-effort; a failure here must not break
    // onboarding. The user can still grant access through the OS directly.
  }
}

export function useMicrophonePermission(): MicrophonePermissionController {
  const [state, setState] = React.useState<MicrophonePermissionState>({
    status: "unknown",
    canRequest: true,
    requesting: false,
  });
  const requestingRef = React.useRef(false);

  const request = React.useCallback(async () => {
    if (requestingRef.current) return;
    requestingRef.current = true;
    setState((current) => ({ ...current, requesting: true }));

    let status: MicrophonePermissionStatus = "unknown";
    let canRequest = true;

    if (hasClientPermissionApi()) {
      try {
        const result = await client.requestPermission(MICROPHONE);
        status = result.status;
        canRequest = result.canRequest;
      } catch {
        // The platform permission client failed (older renderer, missing
        // bridge); fall back to the browser probe rather than surfacing an
        // error the user cannot act on.
        status = await probeMicrophoneViaGetUserMedia();
        canRequest = status !== "denied";
      }
    } else {
      status = await probeMicrophoneViaGetUserMedia();
      canRequest = status !== "denied";
    }

    requestingRef.current = false;
    setState({ status, canRequest, requesting: false });
  }, []);

  const openSettings = React.useCallback(async () => {
    if (hasClientPermissionApi()) {
      await openMicrophoneSettingsViaClient();
      return;
    }
    // No OS-settings deep link in this renderer: re-probe so a permission the
    // user just granted out-of-band is reflected without a manual retry.
    const status = await probeMicrophoneViaGetUserMedia();
    setState((current) => ({
      ...current,
      status,
      canRequest: status !== "denied",
    }));
  }, []);

  return {
    ...state,
    request,
    openSettings,
  };
}
