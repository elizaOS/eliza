import { Button, IconTooltip } from "@elizaos/ui";
import { AlertTriangle } from "lucide-react";
import { type CSSProperties, memo, type PointerEvent } from "react";
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
          className="inline-flex h-11 w-11 min-h-touch min-w-touch items-center justify-center rounded-xl border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt"
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
