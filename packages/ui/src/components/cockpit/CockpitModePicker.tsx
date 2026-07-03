import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SegmentedControl } from "../ui/segmented-control";
import {
  type CockpitModeBadge,
  type CockpitModeConfig,
  type ElizaCloudTier,
  optionIdForConfig,
  tierForConfig,
  visibleCockpitModeOptions,
} from "./cockpit-modes";

const BADGE_LABEL: Record<CockpitModeBadge, string> = {
  cloud: "Cloud",
  sub: "Subscription",
  exp: "Experimental",
};

const BADGE_CLASS: Record<CockpitModeBadge, string> = {
  cloud: "text-accent border-accent/30 bg-accent-subtle",
  sub: "text-muted border-border",
  exp: "text-destructive border-destructive/40",
};

export interface CockpitModePickerProps {
  /** The currently-selected mode config. */
  value: CockpitModeConfig;
  /** Called with the new config when the user picks a mode or flips the tier. */
  onChange: (config: CockpitModeConfig) => void;
  /** Arm the TOS-unsafe experimental options (hidden by default). */
  experimentalEnabled?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * The per-session mode picker for the coding cockpit. Presentational: it renders
 * the four locked modes as selectable cards and, for Eliza Cloud, a Fast/Smart
 * tier toggle. It emits a {@link CockpitModeConfig}; the app layer lowers that
 * to the orchestrator create-task `providerPolicy`.
 */
export function CockpitModePicker({
  value,
  onChange,
  experimentalEnabled = false,
  disabled = false,
  className,
}: CockpitModePickerProps) {
  const options = visibleCockpitModeOptions(experimentalEnabled);
  const selectedId = optionIdForConfig(value);
  const tier = tierForConfig(value);

  const select = (toConfig: (t: ElizaCloudTier) => CockpitModeConfig) => {
    if (disabled) return;
    onChange(toConfig(tier));
  };

  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      data-testid="cockpit-mode-picker"
    >
      {options.map((option) => {
        const isActive = option.id === selectedId;
        return (
          <div key={option.id} className="flex flex-col gap-2">
            <Button
              variant="ghost"
              aria-pressed={isActive}
              disabled={disabled}
              data-testid={`cockpit-mode-${option.id}`}
              onClick={() => select(option.toConfig)}
              className={cn(
                "h-auto w-full justify-between gap-3 rounded-md border px-3.5 py-2.5 text-left transition-colors",
                isActive
                  ? "border-accent bg-accent-subtle"
                  : "border-border hover:bg-bg-hover",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-semibold text-txt">
                  {option.title}
                </span>
                <span className="truncate text-xs text-muted">
                  {option.subtitle}
                </span>
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  BADGE_CLASS[option.badge],
                )}
              >
                {BADGE_LABEL[option.badge]}
              </span>
            </Button>

            {isActive && option.id === "eliza-cloud" ? (
              <SegmentedControl<ElizaCloudTier>
                className="ml-1"
                value={tier}
                onValueChange={(nextTier) =>
                  !disabled &&
                  onChange({
                    mode: "eliza-cloud",
                    agentType: "elizaos",
                    tier: nextTier,
                  })
                }
                items={[
                  {
                    value: "small",
                    label: "Fast",
                    testId: "cockpit-tier-small",
                  },
                  {
                    value: "large",
                    label: "Smart",
                    testId: "cockpit-tier-large",
                  },
                ]}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
