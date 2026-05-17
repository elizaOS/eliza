import { type SubscriptionProviderStatus } from "@elizaos/shared";
import { type Dispatch, type SetStateAction } from "react";
import type { useCloudModelConfig } from "./useCloudModelConfig";
import type { useProviderSelection } from "./useProviderSelection";
export interface ProviderBootstrapState {
  subscriptionStatus: SubscriptionProviderStatus[];
  anthropicConnected: boolean;
  setAnthropicConnected: Dispatch<SetStateAction<boolean>>;
  anthropicCliDetected: boolean;
  openaiConnected: boolean;
  setOpenaiConnected: Dispatch<SetStateAction<boolean>>;
  loadSubscriptionStatus: () => Promise<void>;
}
export declare function useProviderBootstrap(
  selection: ReturnType<typeof useProviderSelection>,
  cloudModel: ReturnType<typeof useCloudModelConfig>,
): ProviderBootstrapState;
//# sourceMappingURL=useProviderBootstrap.d.ts.map
