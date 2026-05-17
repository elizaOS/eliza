import type { SandboxMode } from "../../../onboarding/state-machine";
export interface StateDeviceSecurityProps {
    sandboxMode: SandboxMode | undefined;
    onChoose: (mode: SandboxMode) => void;
    onContinue: () => void;
    onBack: () => void;
}
export declare function StateDeviceSecurity(props: StateDeviceSecurityProps): React.JSX.Element;
//# sourceMappingURL=StateDeviceSecurity.d.ts.map