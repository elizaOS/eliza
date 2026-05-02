import type { FineTuningViewProps } from "../../config/boot-config";
import { useBootConfig } from "../../config/boot-config-react";

export function FineTuningView(props: FineTuningViewProps) {
  const { fineTuningView: FineTuningViewComponent } = useBootConfig();
  return FineTuningViewComponent ? (
    <FineTuningViewComponent {...props} />
  ) : null;
}
