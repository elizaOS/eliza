"use client";

import { FileIcon } from "./FileIcon";
import { cn } from "@/lib/utils";
import { ToolUseBlock } from "./ToolUseBlock";

interface ToolGrepProps {
  input: {
    pattern: string;
    path?: string;
    glob?: string;
    type?: string;
    output_mode?: string;
    "-i"?: boolean;
    "-n"?: boolean;
    context?: number;
    "-A"?: number;
    "-B"?: number;
    "-C"?: number;
  };
  result?: string;
  isError?: boolean;
  isRunning?: boolean;
  startedAt?: number;
  completedAt?: number;
}

interface GrepMatch {
  file: string;
  lineNo?: number;
  content: string;
  isContext?: boolean;
}

interface GrepGroup {
  file: string;
  matches: GrepMatch[];
}

function parseGrepOutput(result: string): GrepGroup[] {
  const lines = result.split("\n").filter(Boolean);
  const groups: Map<string, GrepMatch[]> = new Map();

  for (const line of lines) {
    // Format: "file:lineNo:content" or "file:content" or just "file"
    const colonMatch = line.match(/^([^:]+):(\d+):(.*)$/);
    if (colonMatch) {
      const [, file, lineNo, content] = colonMatch;
      if (!groups.has(file)) groups.set(file, []);
      groups.get(file)!.push({ file, lineNo: parseInt(lineNo, 10), content });
    } else if (line.match(/^[^:]+$/)) {
      // Files-only mode
      if (!groups.has(line)) groups.set(line, []);
    } else {
      // fallback: treat entire line as content with unknown file
      if (!groups.has("")) groups.set("", []);
      groups.get("")!.push({ file: "", content: line });
    }
  }

  return Array.from(groups.entries()).map(([file, matches]) => ({
    file,
    matches,
  }));
}

function highlightPattern(text: string, pattern: string): React.ReactNode {
  try {
    const re = new RegExp(`(${pattern})`, "gi");
    const parts = text.split(re);
    return parts.map((part, i) =>
      re.test(part) ? (
        <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded-sm">
          {part}
        </mark>
      ) : (
        part
      )
    );
  } catch {
    return text;
  }
}

export function ToolGrep({
  input,
  result,
  isError = false,
  isRunning = false,
  startedAt,
  completedAt,
}: ToolGrepProps) {
  const groups = result ? parseGrepOutput(result) : [];
  const totalMatches = groups.reduce((sum, g) => sum + g.matches.length, 0);

  const flags = [
    input["-i"] && "-i",
    input["-n"] !== false && "-n",
    input.glob && `--glob ${input.glob}`,
    input.type && `--type ${input.type}`,
    input.context && `-C ${input.context}`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <ToolUseBlock
      toolName="grep"
      toolInput={input}
      toolResult={result}
      isError={isError}
      isRunning={isRunning}
      startedAt={startedAt}
      completedAt={completedAt}
    >
      {/* Search header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-850 border-b border-surface-700/50 flex-wrap">
        <code className="font-mono text-xs text-yellow-300">{input.pattern}</code>
        {flags && <span className="text-xs text-surface-500 font-mono">{flags}</span>}
        {input.path && (
          <span className="text-xs text-surface-500">in {input.path}</span>
        )}
        {!isRunning && totalMatches > 0 && (
          <span className="ml-auto text-xs text-surface-500">
            {totalMatches} match{totalMatches !== 1 ? "es" : ""}
          </span>
        )}
      </div>

      {/* Results */}
      {isRunning ? (
        <div className="px-3 py-4 text-surface-500 text-xs animate-pulse">
          Searching…
        </div>
      ) : isError ? (
        <div className="px-3 py-3 text-red-400 text-xs font-mono">{result}</div>
      ) : groups.length === 0 ? (
        <div className="px-3 py-3 text-surface-500 text-xs">No matches found.</div>
      ) : (
        <div className="overflow-auto max-h-[400px]">
          {groups.map((group, gi) => (
            <div key={gi} className="border-b border-surface-700/40 last:border-0">
              {/* File header */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-800/40 sticky top-0">
                <FileIcon
                  filePath={group.file}
                  className="w-3.5 h-3.5 text-surface-400 flex-shrink-0"
                />
                <span className="font-mono text-xs text-surface-300 truncate">
                  {group.file || "(unknown)"}
                </span>
                <span className="ml-auto text-xs text-surface-500 flex-shrink-0">
                  {group.matches.length} match{group.matches.length !== 1 ? "es" : ""}
                </span>
              </div>

              {/* Match lines */}
              {group.matches.map((match, mi) => (
                <div
                  key={mi}
                  className={cn(
                    "flex font-mono text-xs leading-5 hover:bg-surface-800/30",
                    match.isContext ? "text-surface-500" : "text-surface-200"
                  )}
                >
                  {match.lineNo !== undefined && (
                    <span className="select-none text-right text-surface-600 pr-2 pl-3 w-12 border-r border-surface-700/50 flex-shrink-0">
                      {match.lineNo}
                    </span>
                  )}
                  <span className="pl-3 pr-4 py-0.5 whitespace-pre">
                    {highlightPattern(match.content, input.pattern)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </ToolUseBlock>
  );
}
