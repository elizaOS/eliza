"use client";

import { useState } from "react";
import { Copy, Check, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnsiRenderer } from "./AnsiRenderer";
import { ToolUseBlock } from "./ToolUseBlock";

interface ToolBashProps {
  input: {
    command: string;
    timeout?: number;
    description?: string;
  };
  result?: string;
  isError?: boolean;
  isRunning?: boolean;
  startedAt?: number;
  completedAt?: number;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="p-1 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-700 transition-colors"
      title="Copy command"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-green-400" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

// Parse exit code from result — bash tool often appends it
function parseExitCode(result: string): number | null {
  const match = result.match(/\nExit code: (\d+)\s*$/);
  if (match) return parseInt(match[1], 10);
  return null;
}

function stripExitCode(result: string): string {
  return result.replace(/\nExit code: \d+\s*$/, "");
}

const MAX_OUTPUT_LINES = 200;

export function ToolBash({
  input,
  result,
  isError = false,
  isRunning = false,
  startedAt,
  completedAt,
}: ToolBashProps) {
  const [showAll, setShowAll] = useState(false);

  const exitCode = result ? parseExitCode(result) : null;
  const outputText = result ? stripExitCode(result) : "";
  const outputLines = outputText.split("\n");
  const isTruncated = !showAll && outputLines.length > MAX_OUTPUT_LINES;
  const displayOutput = isTruncated
    ? outputLines.slice(0, MAX_OUTPUT_LINES).join("\n")
    : outputText;

  // Determine if it's an error (non-zero exit code or isError prop)
  const hasError = isError || (exitCode !== null && exitCode !== 0);

  return (
    <ToolUseBlock
      toolName="bash"
      toolInput={input}
      toolResult={result}
      isError={hasError}
      isRunning={isRunning}
      startedAt={startedAt}
      completedAt={completedAt}
    >
      {/* Command display */}
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-850 border-b border-surface-700/50">
        <span className="text-brand-400 font-mono text-xs select-none">$</span>
        <code className="font-mono text-xs text-surface-100 flex-1 break-all">
          {input.command}
        </code>
        <div className="flex items-center gap-1 flex-shrink-0">
          {input.timeout && (
            <span
              className="flex items-center gap-1 text-xs text-surface-500"
              title={`Timeout: ${input.timeout}ms`}
            >
              <Clock className="w-3 h-3" />
              {(input.timeout / 1000).toFixed(0)}s
            </span>
          )}
          <CopyButton text={input.command} />
        </div>
      </div>

      {/* Output */}
      {isRunning ? (
        <div className="px-3 py-3 font-mono text-xs text-brand-400 animate-pulse-soft">
          Running…
        </div>
      ) : outputText ? (
        <div>
          <div
            className={cn(
              "overflow-auto max-h-[400px] bg-[#0d0d0d] px-3 py-3",
              "font-mono text-xs leading-5 whitespace-pre"
            )}
          >
            <AnsiRenderer text={displayOutput} />
            {isTruncated && (
              <button
                onClick={() => setShowAll(true)}
                className="mt-2 block text-brand-400 hover:text-brand-300 text-xs"
              >
                ↓ Show {outputLines.length - MAX_OUTPUT_LINES} more lines
              </button>
            )}
          </div>

          {/* Footer: exit code */}
          {exitCode !== null && (
            <div
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 border-t border-surface-700/50",
                exitCode === 0 ? "bg-surface-850" : "bg-red-950/20"
              )}
            >
              <span className="text-xs text-surface-500">Exit code</span>
              <span
                className={cn(
                  "font-mono text-xs px-1.5 py-0.5 rounded",
                  exitCode === 0
                    ? "bg-green-900/40 text-green-400"
                    : "bg-red-900/40 text-red-400"
                )}
              >
                {exitCode}
              </span>
            </div>
          )}
        </div>
      ) : null}
    </ToolUseBlock>
  );
}
