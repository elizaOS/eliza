"use client";

import { useState } from "react";
import { ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolUseBlock } from "./ToolUseBlock";

interface ToolWebFetchProps {
  input: {
    url: string;
    prompt?: string;
  };
  result?: string;
  isError?: boolean;
  isRunning?: boolean;
  startedAt?: number;
  completedAt?: number;
}

// Very rough HTTP status parsing from result text
function parseStatus(result: string): number | null {
  const m = result.match(/^(?:HTTP[^\n]*\s)?(\d{3})\b/m);
  if (m) return parseInt(m[1], 10);
  return null;
}

function StatusBadge({ code }: { code: number | null }) {
  if (!code) return null;
  const isOk = code >= 200 && code < 300;
  return (
    <span
      className={cn(
        "text-xs px-1.5 py-0.5 rounded font-mono",
        isOk
          ? "bg-green-900/40 text-green-400 border border-green-800/40"
          : "bg-red-900/40 text-red-400 border border-red-800/40"
      )}
    >
      {code}
    </span>
  );
}

const MAX_VISIBLE = 80;

export function ToolWebFetch({
  input,
  result,
  isError = false,
  isRunning = false,
  startedAt,
  completedAt,
}: ToolWebFetchProps) {
  const [showFull, setShowFull] = useState(false);

  const status = result ? parseStatus(result) : null;
  const isTruncated = !showFull && result && result.length > MAX_VISIBLE * 10;

  return (
    <ToolUseBlock
      toolName="webfetch"
      toolInput={input}
      toolResult={result}
      isError={isError}
      isRunning={isRunning}
      startedAt={startedAt}
      completedAt={completedAt}
    >
      {/* URL header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-850 border-b border-surface-700/50">
        <a
          href={input.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-xs text-brand-400 hover:text-brand-300 hover:underline truncate flex-1 flex items-center gap-1"
        >
          {input.url}
          <ExternalLink className="w-3 h-3 flex-shrink-0" />
        </a>
        {status && <StatusBadge code={status} />}
      </div>

      {/* Prompt if any */}
      {input.prompt && (
        <div className="px-3 py-2 border-b border-surface-700/50 text-xs text-surface-400 italic">
          Prompt: {input.prompt}
        </div>
      )}

      {/* Response body */}
      {isRunning ? (
        <div className="px-3 py-4 text-surface-500 text-xs animate-pulse">
          Fetching…
        </div>
      ) : isError ? (
        <div className="px-3 py-3 text-red-400 text-xs font-mono">{result}</div>
      ) : result ? (
        <div>
          <div className="overflow-auto max-h-[400px] px-3 py-3 text-xs text-surface-300 leading-relaxed whitespace-pre-wrap font-mono">
            {isTruncated ? result.slice(0, MAX_VISIBLE * 10) : result}
          </div>
          {isTruncated && (
            <button
              onClick={() => setShowFull(true)}
              className="flex items-center gap-1 mx-3 mb-2 text-xs text-brand-400 hover:text-brand-300"
            >
              <ChevronDown className="w-3.5 h-3.5" />
              Show full response ({Math.round(result.length / 1024)}KB)
            </button>
          )}
          {showFull && (
            <button
              onClick={() => setShowFull(false)}
              className="flex items-center gap-1 mx-3 mb-2 text-xs text-surface-400 hover:text-surface-200"
            >
              <ChevronUp className="w-3.5 h-3.5" />
              Collapse
            </button>
          )}
        </div>
      ) : null}
    </ToolUseBlock>
  );
}
