/**
 * Settings → Wallet section: composes the wallet-keys manager with the embedded
 * RPC/network config page (`ConfigPageView`) in one stack.
 */

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
