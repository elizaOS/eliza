"use client";

import { Input, Label } from "@elizaos/cloud-ui";

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
      <Label className="text-white font-mono text-sm">{label}</Label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#717171] font-mono z-10 pointer-events-none">
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
          className="pl-7 backdrop-blur-sm bg-[rgba(29,29,29,0.3)] border border-[rgba(255,255,255,0.15)] text-[#e1e1e1] h-10 font-mono"
          placeholder="0.00"
        />
      </div>
      <p className="text-xs font-mono text-[#858585]">{description}</p>
    </div>
  );
}
