import { Input } from "../ui/input";
import { Label } from "../ui/label";
import type { SpendingLimitConfig } from "./types";

function UsdInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs-tight text-muted">{label}</Label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs-tight text-muted pointer-events-none">
          $
        </span>
        <Input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            const v = e.target.value.slice(0, 32);
            if (/^(?:\d+(?:\.\d*)?|\.\d*)?$/.test(v)) onChange(v);
          }}
          className="h-8 text-sm pl-7 tabular-nums"
          placeholder="0"
        />
      </div>
    </div>
  );
}

export function SpendingLimitSection({
  config,
  onChange,
}: {
  config: SpendingLimitConfig;
  onChange: (config: SpendingLimitConfig) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <UsdInput
        label="Per Transaction"
        value={config.maxPerTx}
        onChange={(v) => onChange({ ...config, maxPerTx: v })}
      />
      <UsdInput
        label="Daily Max"
        value={config.maxPerDay}
        onChange={(v) => onChange({ ...config, maxPerDay: v })}
      />
      <UsdInput
        label="Weekly Max"
        value={config.maxPerWeek}
        onChange={(v) => onChange({ ...config, maxPerWeek: v })}
      />
    </div>
  );
}

export function spendingSummary(config: SpendingLimitConfig): string {
  return `$${config.maxPerTx}/tx · $${config.maxPerDay}/day · $${config.maxPerWeek}/wk`;
}
