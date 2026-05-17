import type { DevicePath } from "../../../onboarding/state-machine";
export interface StateDeviceModeProps {
  devicePath: DevicePath | undefined;
  onChoose: (path: DevicePath) => void;
  onStartLocalModelDownload: () => void;
  onBack: () => void;
  onContinue: () => void;
}
export declare function StateDeviceMode(
  props: StateDeviceModeProps,
): React.JSX.Element;
//# sourceMappingURL=StateDeviceMode.d.ts.map
