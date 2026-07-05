"use client";

/**
 * Labeled numeric input field for the cloud billing forms.
 */
import { Input, Label } from "@elizaos/ui/cloud-ui";

interface NumericFieldProps {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  min?: number;
  max?: number;
}

/** Currency-prefixed numeric input used by the auto-fund/auto-top-up settings cards. */
export function NumericField({
  label,
  description,
  value,
  onChange,
  disabled,
  min,
  max,
}: NumericFieldProps) {
  return (
    <div className="space-y-1">
      <Label className="text-txt-strong font-mono text-sm">{label}</Label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted font-mono z-10 pointer-events-none">
          $
        </span>
        <Input
          type="number"
          step="0.01"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="pl-7 bg-surface border border-border text-txt h-10 font-mono"
          placeholder="0.00"
        />
      </div>
      <p className="text-xs font-mono text-muted">{description}</p>
    </div>
  );
}
