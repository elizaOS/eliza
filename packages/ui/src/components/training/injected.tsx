import type { FineTuningViewProps } from "../../config/boot-config";
import { useBootConfig } from "../../config/boot-config-react";
import { TrainingDashboard } from "./TrainingDashboard";

export function FineTuningView(props: FineTuningViewProps) {
  const { fineTuningView: FineTuningViewComponent } = useBootConfig();
  const Component = FineTuningViewComponent || TrainingDashboard;
  return <Component {...props} />;
}
