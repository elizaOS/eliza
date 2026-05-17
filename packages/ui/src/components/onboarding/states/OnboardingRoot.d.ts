import {
  type OnboardingFlowState,
  type OnboardingStateId,
} from "../../../onboarding/state-machine";
import type { DeviceProfile } from "./device-profiles";
import { type CloudProvisioningProgress } from "./StateCloudChat";
import { type LocalDownloadProgress } from "./StateLocalDownload";
export interface OnboardingRootProps {
  deviceProfile?: DeviceProfile;
  localDownloadProgress?: LocalDownloadProgress;
  cloudProvisioningProgress?: CloudProvisioningProgress;
  onStartCloudProvisioning?: () => void;
  onStartLocalModelDownload?: () => void;
  onCloudConversationPush?: () => void;
  onComplete?: (state: OnboardingFlowState) => void;
  onStateChange?: (state: OnboardingFlowState) => void;
  initialStateId?: OnboardingStateId;
}
export declare function OnboardingRoot(
  props: OnboardingRootProps,
): React.JSX.Element;
//# sourceMappingURL=OnboardingRoot.d.ts.map
