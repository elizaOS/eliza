"use client";

import * as Switch from "@radix-ui/react-switch";
import type { ExportOptions, ExportFormat } from "@/lib/types";
import { cn } from "@/lib/utils";

interface OptionRowProps {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}

function OptionRow({ id, label, description, checked, onCheckedChange, disabled }: OptionRowProps) {
  return (
    <div className={cn("flex items-center justify-between gap-4 py-2", disabled && "opacity-40")}>
      <label htmlFor={id} className={cn("flex flex-col gap-0.5", !disabled && "cursor-pointer")}>
        <span className="text-sm text-surface-200">{label}</span>
        {description && (
          <span className="text-xs text-surface-500">{description}</span>
        )}
      </label>
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className={cn(
          "w-9 h-5 rounded-full transition-colors outline-none cursor-pointer",
          "data-[state=checked]:bg-brand-600 data-[state=unchecked]:bg-surface-700",
          "disabled:cursor-not-allowed"
        )}
      >
        <Switch.Thumb className="block w-4 h-4 bg-white rounded-full shadow transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5" />
      </Switch.Root>
    </div>
  );
}

interface ExportOptionsProps {
  options: ExportOptions;
  onChange: (opts: Partial<ExportOptions>) => void;
}

export function ExportOptionsPanel({ options, onChange }: ExportOptionsProps) {
  const isJson = options.format === "json";

  return (
    <div className="divide-y divide-surface-800">
      <OptionRow
        id="opt-tool-use"
        label="Include tool use"
        description="Show tool calls and results in the export"
        checked={options.includeToolUse}
        onCheckedChange={(v) => onChange({ includeToolUse: v })}
      />
      <OptionRow
        id="opt-thinking"
        label="Include thinking blocks"
        description="Show extended thinking when present"
        checked={options.includeThinking}
        onCheckedChange={(v) => onChange({ includeThinking: v })}
        disabled={isJson}
      />
      <OptionRow
        id="opt-timestamps"
        label="Include timestamps"
        description="Add date/time to messages and metadata"
        checked={options.includeTimestamps}
        onCheckedChange={(v) => onChange({ includeTimestamps: v })}
      />
      <OptionRow
        id="opt-file-contents"
        label="Include full file contents"
        description="Show complete tool result output (may be large)"
        checked={options.includeFileContents}
        onCheckedChange={(v) => onChange({ includeFileContents: v })}
      />
    </div>
  );
}
