import { Label, Slider } from "@elizaos/ui";
import type { RateLimitConfig } from "./types";

function LabeledSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs-tight text-muted">{label}</Label>
        <span className="text-xs font-semibold text-txt tabular-nums">
          {value} {unit}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]: number[]) => onChange(v)}
      />
    </div>
  );
}

export function RateLimitSection({
  config,
  onChange,
}: {
  config: RateLimitConfig;
  onChange: (config: RateLimitConfig) => void;
}) {
  return (
    <div className="space-y-4">
      <LabeledSlider
        label="Per Hour"
        value={config.maxTxPerHour}
        min={1}
        max={100}
        step={1}
        unit="tx/hr"
        onChange={(v) => onChange({ ...config, maxTxPerHour: v })}
      />
      <LabeledSlider
        label="Per Day"
        value={config.maxTxPerDay}
        min={1}
        max={1000}
        step={1}
        unit="tx/day"
        onChange={(v) => onChange({ ...config, maxTxPerDay: v })}
      />
    </div>
  );
}

export function rateLimitSummary(config: RateLimitConfig): string {
  return `${config.maxTxPerHour}/hr · ${config.maxTxPerDay}/day`;
}
