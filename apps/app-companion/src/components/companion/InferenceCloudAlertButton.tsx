import { Button, IconTooltip } from "@elizaos/app-core";
import { AlertTriangle } from "lucide-react";
import { memo, type CSSProperties, type PointerEvent } from "react";
import { SHELL_ICON_BUTTON_CLASSNAME } from "./shell-control-styles";
import type { CompanionInferenceNotice } from "./resolve-companion-inference-notice";

export interface InferenceCloudAlertButtonProps {
  notice: CompanionInferenceNotice;
  onPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void;
  onClick: () => void;
}

export const InferenceCloudAlertButton = memo(
  function InferenceCloudAlertButton(props: InferenceCloudAlertButtonProps) {
    const { notice, onPointerDown, onClick } = props;
    const isDanger = notice.variant === "danger";
    const toneVar = isDanger ? "var(--danger)" : "var(--warn)";
    const toneStyle: CSSProperties = {
      borderColor: `color-mix(in srgb, ${toneVar} 34%, var(--border))`,
      backgroundColor: `color-mix(in srgb, ${toneVar} 10%, transparent)`,
      backgroundImage: `linear-gradient(180deg, color-mix(in srgb, ${toneVar} 18%, rgba(255,255,255,0.1)), color-mix(in srgb, ${toneVar} 10%, transparent))`,
      color: `color-mix(in srgb, var(--text-strong) 78%, ${toneVar} 22%)`,
    };

    return (
      <IconTooltip label={notice.tooltip} position="bottom" multiline>
        <Button
          size="icon"
          variant="outline"
          className={SHELL_ICON_BUTTON_CLASSNAME}
          aria-label={notice.tooltip}
          data-testid="companion-inference-cloud-alert"
          onPointerDown={onPointerDown}
          onClick={onClick}
          style={toneStyle}
        >
          <AlertTriangle className="pointer-events-none h-5 w-5 shrink-0" />
        </Button>
      </IconTooltip>
    );
  },
);
