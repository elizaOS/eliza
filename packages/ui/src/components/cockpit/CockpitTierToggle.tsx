/**
 * Presents the Fast/Smart tier selector that a running cockpit session pane
 * uses to persist the desired Eliza Cloud provider policy.
 */
import { SegmentedControl } from "../ui/segmented-control";
import type { ElizaCloudTier } from "./cockpit-modes";

export interface CockpitTierToggleProps {
  /** Current Eliza Cloud tier of the running session. */
  value: ElizaCloudTier;
  /** Called with the selected tier when the user flips it. */
  onChange: (tier: ElizaCloudTier) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Standalone Fast/Smart tier toggle for a RUNNING Eliza Cloud session (the
 * session pane mounts it). Flipping it re-points the task's `providerPolicy` to
 * the selected Eliza Cloud tier model; the orchestrator
 * applies it on the next agent turn. There is intentionally no in-place
 * "no-restart" model swap — an ACP subprocess binds its model at spawn, so the
 * honest mechanism is persist-policy + re-spawn, which the container wires.
 * Purely presentational.
 */
export function CockpitTierToggle({
  value,
  onChange,
  disabled,
  className,
}: CockpitTierToggleProps) {
  return (
    <SegmentedControl<ElizaCloudTier>
      className={className}
      value={value}
      onValueChange={(next) => {
        if (!disabled && next !== value) onChange(next);
      }}
      items={[
        {
          value: "small",
          label: "Fast",
          disabled,
          testId: "cockpit-tier-small",
        },
        {
          value: "large",
          label: "Smart",
          disabled,
          testId: "cockpit-tier-large",
        },
      ]}
    />
  );
}
