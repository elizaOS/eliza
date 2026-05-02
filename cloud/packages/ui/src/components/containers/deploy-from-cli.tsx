"use client";

import { Check, ChevronDown, ChevronUp, Copy, Terminal } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function DeployFromCLI() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const command = "elizaos deploy";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-neutral-900 rounded-xl overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-start justify-between gap-3 p-4 text-left transition-colors hover:bg-white/5 sm:items-center"
      >
        <div className="flex min-w-0 items-start gap-3 sm:items-center">
          <Terminal className="h-5 w-5 shrink-0 text-[#FF5800]" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">Deploy from CLI</p>
            <p className="text-xs text-neutral-500">
              Deploy additional elizaOS projects using the command line
            </p>
          </div>
        </div>
        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-neutral-500" />
        ) : (
          <ChevronDown className="h-4 w-4 text-neutral-500" />
        )}
      </button>

      <div
        className={cn(
          "overflow-hidden transition-all duration-200",
          isExpanded ? "max-h-40" : "max-h-0",
        )}
      >
        <div className="px-4 pb-4">
          <div className="flex min-w-0 items-center gap-3 rounded-lg border border-white/10 bg-black/40 px-4 py-3">
            <span className="text-neutral-600 select-none">$</span>
            <code className="min-w-0 flex-1 truncate font-mono text-sm text-neutral-300">
              {command}
            </code>
            <button
              onClick={handleCopy}
              className="text-neutral-500 hover:text-white transition-colors"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-neutral-500 mt-2">
            Run this command from your elizaOS project directory
          </p>
        </div>
      </div>
    </div>
  );
}
