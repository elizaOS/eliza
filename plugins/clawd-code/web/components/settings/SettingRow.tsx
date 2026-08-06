"use client";

import { cn } from "@/lib/utils";

interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  stack?: boolean;
}

export function SettingRow({ label, description, children, className, stack = false }: SettingRowProps) {
  return (
    <div
      className={cn(
        "py-4 border-b border-surface-800 last:border-0",
        stack ? "flex flex-col gap-3" : "flex items-start justify-between gap-6",
        className
      )}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-surface-100">{label}</p>
        {description && (
          <p className="text-xs text-surface-400 mt-0.5 leading-relaxed">{description}</p>
        )}
      </div>
      <div className={cn("flex-shrink-0", stack && "w-full")}>{children}</div>
    </div>
  );
}

interface SectionHeaderProps {
  title: string;
  onReset?: () => void;
}

export function SectionHeader({ title, onReset }: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-2">
      <h2 className="text-base font-semibold text-surface-100">{title}</h2>
      {onReset && (
        <button
          onClick={onReset}
          className="text-xs text-surface-400 hover:text-surface-200 transition-colors"
        >
          Reset to defaults
        </button>
      )}
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, disabled = false }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent",
        "transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-900",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-brand-600" : "bg-surface-700"
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow",
          "transition duration-200 ease-in-out",
          checked ? "translate-x-4" : "translate-x-0"
        )}
      />
    </button>
  );
}

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  showValue?: boolean;
  unit?: string;
  className?: string;
}

export function Slider({ value, min, max, step = 1, onChange, showValue = true, unit = "", className }: SliderProps) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 h-1.5 bg-surface-700 rounded-full appearance-none cursor-pointer accent-brand-500"
      />
      {showValue && (
        <span className="text-xs text-surface-300 w-12 text-right font-mono">
          {value}{unit}
        </span>
      )}
    </div>
  );
}
