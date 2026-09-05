/**
 * Manages the optional omi wearable microphone on supported transports.
 * Connection progress, failures, battery, and the last transcript remain visible
 * when supported; platforms without a pendant transport omit this accessory UI.
 */

import {
  BatteryLow,
  BatteryMedium,
  Bluetooth,
  BluetoothConnected,
  Loader2,
  Radio,
} from "lucide-react";
import type * as React from "react";
import {
  isPendantLiveStatus,
  pendantConnectStepLabel,
  pendantStatusLabel,
} from "../../pendant/pendant-status";
import { usePendant } from "../../pendant/usePendant";
import { Button } from "../ui/button";
import { SettingsGroup, SettingsRow } from "./settings-layout";

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

export function PendantSettingsCard(): React.ReactElement | null {
  const { state, supported, connect, disconnect } = usePendant();
  if (!supported) return null;
  const live = isPendantLiveStatus(state.status);
  const busy =
    state.status === "requesting" ||
    state.status === "connecting" ||
    state.status === "reconnecting";

  const StatusIcon = live ? BluetoothConnected : Bluetooth;

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
              {pendantStatusLabel(state.status)}
            </span>
            {(state.status === "connecting" ||
              state.status === "reconnecting") &&
            pendantConnectStepLabel(state.connectStep) ? (
              <span
                className="font-mono text-2xs text-muted/80"
                data-testid="pendant-connect-step"
              >
                {pendantConnectStepLabel(state.connectStep)}...
              </span>
            ) : null}
            {state.status === "hearing" ? (
              <Radio
                className="size-4 animate-pulse text-accent motion-reduce:animate-none"
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
          live ? (
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

      {state.error ? (
        <SettingsRow
          label="Error"
          description={
            <span className="text-danger" data-testid="pendant-error">
              {state.typedError?.message ?? state.error}
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
