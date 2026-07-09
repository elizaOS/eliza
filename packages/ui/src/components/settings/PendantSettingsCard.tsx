/**
 * PendantSettingsCard — Settings → Voice control for the omi DevKit1 pendant.
 *
 * Renders a connect/disconnect affordance for the BLE wearable mic, live
 * connection + "hearing audio" state, battery level, and the last transcript it
 * dispatched into chat. Web Bluetooth is desktop-Chrome / Android-Chrome only,
 * so on unsupported browsers (notably iOS Safari / installed PWA) the control
 * degrades to an explanatory note instead of a dead button.
 *
 * Design: black/white/orange token system only (`text-accent`, `bg-accent`,
 * `text-muted`, `bg-status-success` …), lucide icons, no gradients, no emoji.
 */

import {
  BatteryLow,
  BatteryMedium,
  Bluetooth,
  BluetoothConnected,
  BluetoothOff,
  Loader2,
  Radio,
} from "lucide-react";
import * as React from "react";

import { usePendant } from "../../pendant/usePendant";
import type { PendantStatus } from "../../pendant/pendant-connection";
import type { PendantConnectStep } from "../../pendant/connect-timeout";
import { Button } from "../ui/button";
import { SettingsGroup, SettingsRow } from "./settings-layout";

function statusLabel(status: PendantStatus): string {
  switch (status) {
    case "unsupported":
      return "Not supported in this browser";
    case "idle":
      return "Not connected";
    case "requesting":
      return "Choose a device…";
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected";
    case "listening":
      return "Listening";
    case "hearing":
      return "Hearing you…";
    case "transcribing":
      return "Transcribing…";
    case "error":
      return "Connection error";
  }
}

/** Short human label for the in-flight connect step (shown while connecting). */
function connectStepLabel(step: PendantConnectStep): string | null {
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

/** Whether the pendant is in any live/connected phase. */
function isLive(status: PendantStatus): boolean {
  return (
    status === "connected" ||
    status === "listening" ||
    status === "hearing" ||
    status === "transcribing"
  );
}

function BatteryBadge({ percent }: { percent: number }): React.ReactElement {
  const Icon = percent <= 20 ? BatteryLow : BatteryMedium;
  return (
    <span
      className="inline-flex items-center gap-1 text-2xs text-muted"
      data-testid="pendant-battery"
    >
      <Icon className="size-4" aria-hidden />
      {percent}%
    </span>
  );
}

export function PendantSettingsCard(): React.ReactElement {
  const { state, supported, connect, disconnect } = usePendant();
  const live = isLive(state.status);
  const busy = state.status === "requesting" || state.status === "connecting";

  const StatusIcon = !supported
    ? BluetoothOff
    : live
      ? BluetoothConnected
      : Bluetooth;

  return (
    <SettingsGroup
      title="Pendant"
      description="Connect an omi wearable mic to talk to Eliza hands-free over Bluetooth."
      data-testid="pendant-settings"
    >
      <SettingsRow
        icon={StatusIcon}
        label={state.deviceName ?? "omi pendant"}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span
              className={
                state.status === "hearing"
                  ? "text-accent"
                  : state.status === "error"
                    ? "text-danger"
                    : "text-muted"
              }
              data-testid="pendant-status"
            >
              {statusLabel(state.status)}
            </span>
            {state.status === "connecting" &&
            connectStepLabel(state.connectStep) ? (
              <span
                className="font-mono text-2xs text-muted/80"
                data-testid="pendant-connect-step"
              >
                {connectStepLabel(state.connectStep)}…
              </span>
            ) : null}
            {state.status === "hearing" ? (
              <Radio
                className="size-4 animate-pulse text-accent"
                aria-hidden
                data-testid="pendant-hearing-indicator"
              />
            ) : null}
            {state.batteryPercent !== null ? (
              <BatteryBadge percent={state.batteryPercent} />
            ) : null}
          </span>
        }
        control={
          !supported ? null : live ? (
            <Button
              variant="surfaceDestructive"
              size="sm"
              onClick={disconnect}
              data-testid="pendant-disconnect"
            >
              Disconnect
            </Button>
          ) : (
            <Button
              variant="surfaceAccent"
              size="sm"
              onClick={connect}
              disabled={busy}
              data-testid="pendant-connect"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Bluetooth className="size-4" aria-hidden />
              )}
              {busy ? "Connecting…" : "Connect"}
            </Button>
          )
        }
      />

      {!supported ? (
        <SettingsRow
          label="Bluetooth pendant not available here"
          description="Connect from the Android app, desktop Chrome, or Android Chrome. Web Bluetooth isn't available on iOS Safari — use the native app there instead."
        />
      ) : null}

      {state.error ? (
        <SettingsRow
          label="Error"
          description={
            <span className="text-danger" data-testid="pendant-error">
              {state.error}
            </span>
          }
        />
      ) : null}

      {state.lastTranscript ? (
        <SettingsRow
          label="Last heard"
          description={
            <span className="text-muted" data-testid="pendant-last-transcript">
              “{state.lastTranscript}”
            </span>
          }
        />
      ) : null}
    </SettingsGroup>
  );
}

export default PendantSettingsCard;
