import { ConfigPageView } from "../pages/ConfigPageView";
import { WalletKeysSection } from "./WalletKeysSection";

export function WalletRpcSection() {
  return (
    <div className="space-y-6">
      <WalletKeysSection />
      <ConfigPageView embedded />
    </div>
  );
}
