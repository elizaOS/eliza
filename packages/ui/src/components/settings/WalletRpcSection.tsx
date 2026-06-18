import { ConfigPageView } from "../pages/ConfigPageView";
import { SettingsStack } from "./settings-layout";
import { WalletKeysSection } from "./WalletKeysSection";

export function WalletRpcSection() {
  return (
    <SettingsStack>
      <WalletKeysSection />
      <ConfigPageView embedded />
    </SettingsStack>
  );
}
