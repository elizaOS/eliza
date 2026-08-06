"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileIcon } from "./FileIcon";
import { SyntaxHighlight, getLanguageFromPath } from "./SyntaxHighlight";
import { ToolUseBlock } from "./ToolUseBlock";

interface ToolFileReadProps {
  input: {
    file_path: string;
    offset?: number;
    limit?: number;
  };
  result?: string;
  isError?: boolean;
  isRunning?: boolean;
  startedAt?: number;
  completedAt?: number;
}

function FileBreadcrumb({ filePath }: { filePath: string }) {
  const parts = filePath.replace(/^\//, "").split("/");
  return (
    <div className="flex items-center gap-1 font-mono text-xs text-surface-400 flex-wrap">
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="w-3 h-3 text-surface-600" />}
          <span
            className={
              i === parts.length - 1 ? "text-surface-200 font-medium" : ""
            }
          >
            {part}
          </span>
        </span>
      ))}
    </div>
  );
}

const MAX_LINES_COLLAPSED = 40;

export function ToolFileRead({
  input,
  result,
  isError = false,
  isRunning = false,
  startedAt,
  completedAt,
}: ToolFileReadProps) {
  const [showAll, setShowAll] = useState(false);
  const lang = getLanguageFromPath(input.file_path);

  const lines = result?.split("\n") ?? [];
  const isTruncated = !showAll && lines.length > MAX_LINES_COLLAPSED;
  const displayContent = isTruncated
    ? lines.slice(0, MAX_LINES_COLLAPSED).join("\n")
    : (result ?? "");

  return (
    <ToolUseBlock
      toolName="read"
      toolInput={input}
      toolResult={result}
      isError={isError}
      isRunning={isRunning}
      startedAt={startedAt}
      completedAt={completedAt}
    >
      {/* File path header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-700/50 bg-surface-850">
        <FileIcon
          filePath={input.file_path}
          className="w-3.5 h-3.5 text-surface-400 flex-shrink-0"
        />
        <FileBreadcrumb filePath={input.file_path} />
        {(input.offset !== undefined || input.limit !== undefined) && (
          <span className="ml-auto text-xs text-surface-500 flex-shrink-0">
            {input.offset !== undefined && `offset: ${input.offset}`}
            {input.offset !== undefined && input.limit !== undefined && " · "}
            {input.limit !== undefined && `limit: ${input.limit}`}
          </span>
        )}
      </div>

      {/* Content */}
      {isRunning ? (
        <div className="px-3 py-4 text-surface-500 text-xs animate-pulse">
          Reading…
        </div>
      ) : isError ? (
        <div className="px-3 py-3 text-red-400 text-xs font-mono">{result}</div>
      ) : result ? (
        <div className="relative">
          <div className="overflow-auto max-h-[480px] [&_pre]:!bg-transparent [&_pre]:!m-0 [&_.shiki]:!bg-transparent">
            <SyntaxHighlight
              code={displayContent}
              lang={lang}
              className="text-xs [&_pre]:p-3 [&_pre]:leading-5"
            />
          </div>
          {isTruncated && (
            <div className="flex justify-center py-2 border-t border-surface-700/50 bg-surface-850">
              <button
                onClick={() => setShowAll(true)}
                className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1"
              >
                <ChevronDown className="w-3.5 h-3.5" />
                Show {lines.length - MAX_LINES_COLLAPSED} more lines
              </button>
            </div>
          )}
        </div>
      ) : null}
    </ToolUseBlock>
  );
}
