"use client";

import { FileIcon } from "./FileIcon";
import { ToolUseBlock } from "./ToolUseBlock";

interface ToolGlobProps {
  input: {
    pattern: string;
    path?: string;
  };
  result?: string;
  isError?: boolean;
  isRunning?: boolean;
  startedAt?: number;
  completedAt?: number;
}

function parseFilePaths(result: string): string[] {
  return result
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function ToolGlob({
  input,
  result,
  isError = false,
  isRunning = false,
  startedAt,
  completedAt,
}: ToolGlobProps) {
  const files = result ? parseFilePaths(result) : [];
  const fileCount = files.length;

  return (
    <ToolUseBlock
      toolName="glob"
      toolInput={input}
      toolResult={result}
      isError={isError}
      isRunning={isRunning}
      startedAt={startedAt}
      completedAt={completedAt}
    >
      {/* Pattern header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-850 border-b border-surface-700/50">
        <code className="font-mono text-xs text-brand-300">{input.pattern}</code>
        {input.path && (
          <span className="text-xs text-surface-500">in {input.path}</span>
        )}
        {!isRunning && fileCount > 0 && (
          <span className="ml-auto text-xs text-surface-500">
            {fileCount} match{fileCount !== 1 ? "es" : ""}
          </span>
        )}
      </div>

      {/* File list */}
      {isRunning ? (
        <div className="px-3 py-4 text-surface-500 text-xs animate-pulse">
          Searching…
        </div>
      ) : isError ? (
        <div className="px-3 py-3 text-red-400 text-xs font-mono">{result}</div>
      ) : files.length === 0 ? (
        <div className="px-3 py-3 text-surface-500 text-xs">No matches found.</div>
      ) : (
        <div className="overflow-auto max-h-[320px] py-1">
          {files.map((filePath, i) => (
            <div
              key={i}
              className="flex items-center gap-2 px-3 py-1 hover:bg-surface-800/50 transition-colors"
            >
              <FileIcon
                filePath={filePath}
                className="w-3.5 h-3.5 text-surface-400 flex-shrink-0"
              />
              <span className="font-mono text-xs text-surface-200 truncate">
                {filePath}
              </span>
            </div>
          ))}
        </div>
      )}
    </ToolUseBlock>
  );
}
