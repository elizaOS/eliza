import type { FineTuningViewProps } from "../../config/boot-config";
import { useBootConfig } from "../../config/boot-config-react.hooks";

/**
 * Renders the fine-tuning dashboard the host injects through
 * `bootConfig.fineTuningView`. The real dashboard ships in
 * `@elizaos/plugin-training` (its `FineTuningView`); the UI trunk owns no
 * training components. When the plugin is not installed the host injects
 * nothing, so the shell shows an install hint rather than a trunk fallback.
 */
export function FineTuningView(props: FineTuningViewProps) {
  const { fineTuningView: FineTuningViewComponent } = useBootConfig();
  if (!FineTuningViewComponent) {
    return (
      <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center px-4 text-center text-sm text-muted">
        Fine-tuning requires the Training plugin.
      </div>
    );
  }
  return <FineTuningViewComponent {...props} />;
}
