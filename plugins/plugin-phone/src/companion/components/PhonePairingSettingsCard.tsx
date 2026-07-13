/** Compact Settings → Peripherals card for native iOS Phone Companion pairing. */
import {
  SettingsGroup,
  SettingsRow,
} from "@elizaos/ui/components/settings/settings-layout";
import { Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  ElizaIntent,
  type PairingPayload,
  type PairingStatus,
} from "../services";
import { isNativeIosPhonePairing, PairingControls } from "./Pairing";

type StatusState =
  | { phase: "loading" }
  | { phase: "ready"; status: PairingStatus }
  | { phase: "error" };

const UNPAIRED_STATUS: PairingStatus = {
  paired: false,
  agentUrl: null,
  deviceId: null,
};

export function PhonePairingSettingsCard(): React.JSX.Element {
  const supported = isNativeIosPhonePairing();
  const [state, setState] = useState<StatusState>({ phase: "loading" });

  useEffect(() => {
    if (!supported) return;
    let active = true;
    void ElizaIntent.getPairingStatus()
      .then((status) => {
        if (active) setState({ phase: "ready", status });
      })
      .catch(() => {
        if (active) setState({ phase: "error" });
      });
    return () => {
      active = false;
    };
  }, [supported]);

  const onPaired = useCallback((payload: PairingPayload) => {
    setState({
      phase: "ready",
      status: {
        paired: true,
        agentUrl: payload.ingressUrl,
        deviceId: payload.agentId,
      },
    });
  }, []);

  if (!supported) {
    return (
      <SettingsGroup title="Phone">
        <SettingsRow
          icon={Smartphone}
          label="Pairing"
          description="iOS app only"
        />
      </SettingsGroup>
    );
  }

  const status = state.phase === "ready" ? state.status : UNPAIRED_STATUS;
  const description =
    state.phase === "loading"
      ? "Checking pairing…"
      : state.phase === "error"
        ? "Could not read pairing status."
        : status.paired
          ? `Paired with ${status.deviceId ?? "Eliza"}`
          : "Not paired";

  return (
    <SettingsGroup title="Phone" data-testid="phone-pairing-settings">
      <SettingsRow
        icon={Smartphone}
        label="Pairing"
        description={description}
      />
      <div className="py-2.5">
        <PairingControls compact onPaired={onPaired} />
      </div>
    </SettingsGroup>
  );
}

export default PhonePairingSettingsCard;
