/** Device pairing and Bluetooth accessories managed from one Settings section. */
import { Smartphone } from "lucide-react";
import { useBootConfig } from "../../config/boot-config-react.hooks";
import { PendantSettingsCard } from "./PendantSettingsCard";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

export function PeripheralsSection(): React.JSX.Element {
  const { phonePairingSettingsCard: PhonePairingSettingsCard } =
    useBootConfig();

  return (
    <SettingsStack data-testid="peripherals-settings">
      <PendantSettingsCard />
      {PhonePairingSettingsCard ? (
        <PhonePairingSettingsCard />
      ) : (
        <SettingsGroup title="Phone">
          <SettingsRow
            icon={Smartphone}
            label="Pairing"
            description="Unavailable in this build"
          />
        </SettingsGroup>
      )}
    </SettingsStack>
  );
}

export default PeripheralsSection;
