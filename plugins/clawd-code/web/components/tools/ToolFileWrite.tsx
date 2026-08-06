"use client";

import { ChevronRight } from "lucide-react";
import { FileIcon } from "./FileIcon";
import { SyntaxHighlight, getLanguageFromPath } from "./SyntaxHighlight";
import { ToolUseBlock } from "./ToolUseBlock";

interface ToolFileWriteProps {
  input: {
    file_path: string;
    content: string;
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
            className={i === parts.length - 1 ? "text-surface-200 font-medium" : ""}
          >
            {part}
          </span>
        </span>
      ))}
    </div>
  );
}

function isNewFile(result?: string): boolean {
  if (!result) return false;
  return /creat|new/i.test(result);
}

export function ToolFileWrite({
  input,
  result,
  isError = false,
  isRunning = false,
  startedAt,
  completedAt,
}: ToolFileWriteProps) {
  const lang = getLanguageFromPath(input.file_path);
  const lineCount = input.content.split("\n").length;

  return (
    <ToolUseBlock
      toolName="write"
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
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-surface-500">{lineCount} lines</span>
          <span
            className={
              isNewFile(result)
                ? "text-xs px-1.5 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-800/50"
                : "text-xs px-1.5 py-0.5 rounded bg-yellow-900/30 text-yellow-400 border border-yellow-800/40"
            }
          >
            {isNewFile(result) ? "New file" : "Overwrite"}
          </span>
        </div>
      </div>

      {/* Content */}
      {isRunning ? (
        <div className="px-3 py-4 text-surface-500 text-xs animate-pulse">
          Writing…
        </div>
      ) : isError ? (
        <div className="px-3 py-3 text-red-400 text-xs font-mono">{result}</div>
      ) : (
        <div className="overflow-auto max-h-[480px] [&_pre]:!bg-transparent [&_pre]:!m-0 [&_.shiki]:!bg-transparent">
          <SyntaxHighlight
            code={input.content}
            lang={lang}
            className="text-xs [&_pre]:p-3 [&_pre]:leading-5"
          />
        </div>
      )}
    </ToolUseBlock>
  );
}
