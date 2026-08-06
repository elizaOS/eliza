"use client";

import { FileText, Braces, Globe, FileDown, AlignLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExportFormat } from "@/lib/types";

interface FormatOption {
  value: ExportFormat;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const FORMATS: FormatOption[] = [
  {
    value: "markdown",
    label: "Markdown",
    description: "Clean .md with code blocks and metadata",
    icon: <FileText className="w-4 h-4" />,
  },
  {
    value: "json",
    label: "JSON",
    description: "Full conversation data with tool use",
    icon: <Braces className="w-4 h-4" />,
  },
  {
    value: "html",
    label: "HTML",
    description: "Self-contained file with embedded styles",
    icon: <Globe className="w-4 h-4" />,
  },
  {
    value: "pdf",
    label: "PDF",
    description: "Print-to-PDF via browser dialog",
    icon: <FileDown className="w-4 h-4" />,
  },
  {
    value: "plaintext",
    label: "Plain Text",
    description: "Stripped of all formatting",
    icon: <AlignLeft className="w-4 h-4" />,
  },
];

interface FormatSelectorProps {
  value: ExportFormat;
  onChange: (format: ExportFormat) => void;
}

export function FormatSelector({ value, onChange }: FormatSelectorProps) {
  return (
    <div className="grid grid-cols-5 gap-2">
      {FORMATS.map((fmt) => (
        <button
          key={fmt.value}
          onClick={() => onChange(fmt.value)}
          className={cn(
            "flex flex-col items-center gap-1.5 px-2 py-3 rounded-lg border text-center transition-colors",
            value === fmt.value
              ? "border-brand-500 bg-brand-500/10 text-brand-300"
              : "border-surface-700 bg-surface-800 text-surface-400 hover:border-surface-600 hover:text-surface-200"
          )}
          title={fmt.description}
        >
          {fmt.icon}
          <span className="text-xs font-medium leading-none">{fmt.label}</span>
        </button>
      ))}
    </div>
  );
}
