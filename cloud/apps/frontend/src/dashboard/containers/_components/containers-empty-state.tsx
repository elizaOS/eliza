"use client";

import { BrandButton, cn } from "@elizaos/cloud-ui";
import { Check, Copy, Terminal } from "lucide-react";
import { useState } from "react";

export function ContainersEmptyState() {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const commands = ["bun i -g @elizaos/cli", "elizaos deploy"];

  const handleCopy = async (text: string, index: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-6 bg-neutral-900 rounded-xl py-12">
      <div className="text-center space-y-2">
        <h3 className="text-xl font-medium text-white">No containers yet</h3>
        <p className="text-sm text-neutral-500 max-w-sm">
          Deploy your first elizaOS container using the CLI
        </p>
      </div>

      {/* CLI Instructions */}
      <div className="flex flex-col bg-black/60 rounded-lg border border-white/10 overflow-hidden w-full max-w-sm">
        {commands.map((cmd, index) => (
          <div
            key={index}
            className={cn(
              "flex items-center gap-3 px-4 py-3 group",
              index < commands.length - 1 && "border-b border-white/5",
            )}
          >
            <span className="text-neutral-600 select-none">$</span>
            <code className="text-sm text-neutral-300 flex-1 font-mono">{cmd}</code>
            <button
              onClick={() => handleCopy(cmd, index)}
              className="text-neutral-600 hover:text-neutral-300 transition-colors"
            >
              {copiedIndex === index ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
        ))}
      </div>

      <BrandButton
        variant="outline"
        asChild
        className="h-10 text-neutral-400 border-neutral-700 hover:text-white hover:border-neutral-600"
      >
        <a
          href="https://elizaos.github.io/eliza/docs/cli"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Terminal className="h-4 w-4" />
          CLI Documentation
        </a>
      </BrandButton>
    </div>
  );
}
