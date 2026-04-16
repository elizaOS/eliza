import { useBootConfig } from "../../config";
import type { FineTuningViewProps } from "../../config/boot-config";

export function FineTuningView(props: FineTuningViewProps) {
  const { fineTuningView: FineTuningViewComponent } = useBootConfig();
  return FineTuningViewComponent ? <FineTuningViewComponent {...props} /> : null;
}
