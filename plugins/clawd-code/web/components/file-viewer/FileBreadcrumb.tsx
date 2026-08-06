"use client";

import { useState } from "react";
import { Copy, Check, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

interface FileBreadcrumbProps {
  path: string;
  className?: string;
}

export function FileBreadcrumb({ path, className }: FileBreadcrumbProps) {
  const [copied, setCopied] = useState(false);

  const segments = path.split("/").filter(Boolean);
  const isAbsolute = path.startsWith("/");

  const handleCopy = async () => {
    await navigator.clipboard.writeText(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const openInVSCode = () => {
    window.open(`vscode://file${isAbsolute ? path : `/${path}`}`);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 px-3 py-1.5 border-b border-surface-800 bg-surface-900/80",
        "text-xs text-surface-400 min-w-0",
        className
      )}
    >
      {/* Segments */}
      <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-hidden">
        {isAbsolute && (
          <span className="text-surface-600 flex-shrink-0">/</span>
        )}
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-0.5 flex-shrink-0">
            {i > 0 && <span className="text-surface-700 mx-0.5">/</span>}
            <span
              className={cn(
                "truncate max-w-[120px]",
                i === segments.length - 1
                  ? "text-surface-200 font-medium"
                  : "text-surface-500 hover:text-surface-300 cursor-pointer transition-colors"
              )}
              title={seg}
            >
              {seg}
            </span>
          </span>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <button
          onClick={handleCopy}
          className="p-1 rounded hover:bg-surface-800 transition-colors"
          title="Copy path"
        >
          {copied ? (
            <Check className="w-3 h-3 text-green-400" />
          ) : (
            <Copy className="w-3 h-3" />
          )}
        </button>
        <button
          onClick={openInVSCode}
          className="p-1 rounded hover:bg-surface-800 transition-colors"
          title="Open in VS Code"
        >
          <ExternalLink className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
