"use client";

import { ChevronRight } from "lucide-react";
import { FileIcon } from "./FileIcon";
import { DiffView } from "./DiffView";
import { getLanguageFromPath } from "./SyntaxHighlight";
import { ToolUseBlock } from "./ToolUseBlock";

interface ToolFileEditProps {
  input: {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
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

export function ToolFileEdit({
  input,
  result,
  isError = false,
  isRunning = false,
  startedAt,
  completedAt,
}: ToolFileEditProps) {
  const lang = getLanguageFromPath(input.file_path);

  return (
    <ToolUseBlock
      toolName="edit"
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
        {input.replace_all && (
          <span className="ml-auto text-xs px-1.5 py-0.5 rounded bg-surface-700 text-surface-300">
            replace all
          </span>
        )}
      </div>

      {/* Content */}
      {isRunning ? (
        <div className="px-3 py-4 text-surface-500 text-xs animate-pulse">
          Editing…
        </div>
      ) : isError ? (
        <div className="px-3 py-3 text-red-400 text-xs font-mono whitespace-pre-wrap">
          {result}
        </div>
      ) : (
        <div className="p-3">
          <DiffView
            oldContent={input.old_string}
            newContent={input.new_string}
            lang={lang}
          />
        </div>
      )}
    </ToolUseBlock>
  );
}
