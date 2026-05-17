import type { RuntimeChoice } from "../../../onboarding/state-machine";
import { type DeviceProfile } from "./device-profiles";
export interface StateSetupProps {
    deviceProfile: DeviceProfile;
    runtime: RuntimeChoice | undefined;
    language: string;
    onLanguageChange: (language: string) => void;
    onChooseRuntime: (runtime: RuntimeChoice) => void;
    onContinue: (selectedRuntime: RuntimeChoice) => void;
    onChooseRemote: () => void;
}
export declare function StateSetup(props: StateSetupProps): React.JSX.Element;
//# sourceMappingURL=StateSetup.d.ts.map